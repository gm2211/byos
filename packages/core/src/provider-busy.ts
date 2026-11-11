/**
 * Busy providers, rate limits and the messages people see when a request fails.
 *
 * A 429 or overloaded answer is asked again after a short wait (honouring `retry-after` and Claude's
 * `anthropic-ratelimit-unified-*` plan-window headers) before it becomes an error. A rate limit that
 * outlasts the retries starts a cooldown: until it ends, requests to that provider stop at once with
 * the same plain message instead of asking again into a closed window. Background work is never
 * retried, so it cannot crowd out what the reader is waiting for.
 *
 * Every other failure gets one sentence a person can act on (`providerErrorMessage`): raw JSON error
 * bodies never reach the UI. Same rules and vectors as ByosCore (Swift): conformance/provider-busy.json.
 */

import type { CredentialKind } from './credential-mode.js';

export const BUSY_POLICY = {
  busyStatuses: [429, 503, 529] as readonly number[],
  backoffSeconds: [2, 6] as readonly number[],
  /** Longest wait a foreground request sits through before asking again. */
  waitLimitSeconds: 20,
  /** Cooldown after a 429 that does not say how long to wait. */
  defaultCooldownSeconds: 60,
  /** A reset further out than this reads as a plan limit with a time, not "try again in N minutes". */
  planLimitMessageAfterSeconds: 15 * 60,
  lostConnectionRetrySeconds: [0.5, 2] as readonly number[],
} as const;

/** Who failed, for the message: the name people know and how they connected. */
export type BusyProvider = {
  name: string;
  credential: CredentialKind;
  /** Added after a plan-limit message, e.g. "Claude.ai and Claude Code count toward the same limit." */
  sharedLimitNote?: string;
};

/** `foreground`: someone is waiting on it. `background`: prefetch, batch work; never retried. */
export type RequestLane = 'foreground' | 'background';

export type HeaderSource = Headers | Record<string, string | undefined> | { get(name: string): string | null };

/** What a 429 or overloaded response says about when to ask again. Times are Unix seconds. */
export type BusySignal = {
  retryAfterSeconds?: number;
  /** When the plan's usage window reopens (Claude sign-in). */
  resetsAt?: number;
  /** The plan's window is closed, rather than the requests being too fast. */
  planLimitReached: boolean;
};

const nowSeconds = () => Date.now() / 1000;

function header(headers: HeaderSource | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get(name: string): string | null }).get(name)?.trim() || undefined;
  }
  const record = headers as Record<string, string | undefined>;
  const key = Object.keys(record).find(k => k.toLowerCase() === name);
  return key ? record[key]?.trim() || undefined : undefined;
}

const finiteNumber = (value: string | undefined) => {
  if (value === undefined || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

export function busySignal(headers: HeaderSource | undefined, now = nowSeconds()): BusySignal {
  const retryAfter = finiteNumber(header(headers, 'retry-after'));
  const reset = finiteNumber(header(headers, 'anthropic-ratelimit-unified-reset'));
  return {
    retryAfterSeconds: retryAfter !== undefined && retryAfter >= 0 ? retryAfter : undefined,
    resetsAt: reset !== undefined && reset > now ? reset : undefined,
    planLimitReached: header(headers, 'anthropic-ratelimit-unified-status')?.toLowerCase() === 'rejected',
  };
}

/** Seconds to wait before asking again, when the provider said. */
export function busyWaitSeconds(signal: BusySignal, now = nowSeconds()): number | undefined {
  const untilReset = signal.resetsAt !== undefined ? Math.max(0, signal.resetsAt - now) : undefined;
  if (signal.planLimitReached && untilReset !== undefined) return untilReset;
  return signal.retryAfterSeconds ?? untilReset;
}

/** The `error` of a failure body: `{error:{type,message}}` (Anthropic, OpenAI-compatible) or `{error:"..."}` (xAI). */
export function providerErrorEnvelope(body: string | unknown): { type?: string; message?: string } {
  let payload = body;
  if (typeof body === 'string') {
    try { payload = JSON.parse(body); } catch { return {}; }
  }
  if (!payload || typeof payload !== 'object') return {};
  const error = (payload as { error?: unknown }).error;
  if (typeof error === 'string') return { message: error };
  if (!error || typeof error !== 'object') return {};
  const { type, message } = error as { type?: unknown; message?: unknown };
  return { type: typeof type === 'string' ? type : undefined, message: typeof message === 'string' ? message : undefined };
}

/** False for placeholders such as Claude's bare "Error" that would read as broken. */
export function isInformativeErrorDetail(detail: string | undefined): detail is string {
  const trimmed = detail?.trim() ?? '';
  return [...trimmed].length > 10 && trimmed.toLowerCase() !== 'error';
}

const informativeDetail = (body: string) => {
  const message = providerErrorEnvelope(body).message?.trim();
  return isInformativeErrorDetail(message) ? message : undefined;
};

const clip = (text: string, length: number) => {
  const chars = [...text];
  return chars.length > length ? `${chars.slice(0, length).join('')}…` : text;
};

/**
 * A 429 that says nothing about a limit: no `retry-after`, no usage window, and only a placeholder
 * message. Claude answers this way when it turns the request itself down, so asking again gets the
 * same answer and no cooldown should start.
 */
export function isRefusal429(body: string, signal: BusySignal): boolean {
  return informativeDetail(body) === undefined && signal.retryAfterSeconds === undefined
    && signal.resetsAt === undefined && !signal.planLimitReached;
}

/** Formats when a plan window reopens, as the words after "It resets": "at 3:00 PM", "on Monday at 3:00 PM". */
export type ResetFormatter = (resetsAt: number, now: number) => string;

export const formatReset: ResetFormatter = (resetsAt, now) => {
  const at = new Date(resetsAt * 1000);
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (at.toDateString() === new Date(now * 1000).toDateString()) return `at ${time}`;
  return `on ${at.toLocaleDateString(undefined, { weekday: 'long' })} at ${time}`;
};

export type MessageOptions = { now?: number; formatReset?: ResetFormatter };

/** The message for a real rate limit: when it lifts if the provider said, never its boilerplate. */
export function rateLimitMessage(provider: BusyProvider, body: string, signal: BusySignal, options: MessageOptions = {}): string {
  const now = options.now ?? nowSeconds();
  const wait = busyWaitSeconds(signal, now);
  if (signal.resetsAt !== undefined && (signal.planLimitReached || (wait ?? 0) > BUSY_POLICY.planLimitMessageAfterSeconds)) {
    const when = (options.formatReset ?? formatReset)(signal.resetsAt, now);
    const note = provider.sharedLimitNote ? ` ${provider.sharedLimitNote}` : '';
    return `You've reached your ${provider.name} plan's usage limit. It resets ${when}.${note}`;
  }
  let message: string;
  if (wait !== undefined && wait > 0) {
    const minutes = Math.max(1, Math.ceil(wait / 60));
    message = `${provider.name} has hit your account's rate limit. Try again in ${minutes === 1 ? 'a minute' : `${minutes} minutes`}.`;
  } else {
    message = `${provider.name} has hit your account's rate limit for the moment. Try again in a minute.`;
  }
  const detail = informativeDetail(body);
  if (detail && !detail.toLowerCase().includes("would exceed your account's rate limit")) message += ` (${clip(detail, 160)})`;
  return message;
}

export const overloadedMessage = (provider: BusyProvider) => `${provider.name} is overloaded right now. Try again in a minute.`;

export const emptyResponseMessage = (provider: BusyProvider) => `${provider.name} sent back an empty answer. Try again.`;

/**
 * One sentence a person can act on for a failed provider request. Reads the provider's error
 * envelope where there is one; never returns the raw body.
 */
export function providerErrorMessage(
  provider: BusyProvider,
  status: number,
  body: string,
  headers?: HeaderSource,
  options: MessageOptions = {},
): string {
  const now = options.now ?? nowSeconds();
  const { name } = provider;
  const unavailable = `${name} is temporarily unavailable. Try again shortly.`;
  switch (true) {
    case status === 401:
      return provider.credential === 'subscription'
        ? `${name} sign-in expired. Sign in again in Settings.`
        : `${name} rejected the API key. Check it in Settings.`;
    case status === 402 || status === 403:
      return `Your ${name} plan doesn't allow this request.`;
    case status === 429: {
      const signal = busySignal(headers, now);
      if (isRefusal429(body, signal)) {
        const next = provider.credential === 'subscription' ? `sign in to ${name} again in Settings` : 'check your account in Settings';
        return `${name} turned down this request without saying why (429). Try another model, or ${next}.`;
      }
      return rateLimitMessage(provider, body, signal, { ...options, now });
    }
    case status >= 500 && status <= 599:
      return unavailable;
  }
  const envelope = providerErrorEnvelope(body);
  if (envelope.type === 'overloaded_error') return unavailable;
  const detail = envelope.message?.trim();
  if (isInformativeErrorDetail(detail)) return `${name} couldn't run this request: ${clip(detail, 240)}`;
  return `${name} request failed (${status}). Try again.`;
}

/** What to do with one response. `fail` carries the message to show and, for a rate limit, the cooldown. */
export type BusyDecision =
  | { action: 'success' }
  | { action: 'return' }
  | { action: 'retry'; waitSeconds: number }
  | { action: 'fail'; message: string; cooldownSeconds?: number };

export type BusyInput = {
  provider: BusyProvider;
  status: number;
  headers?: HeaderSource;
  body: string;
  /** Retries already made for this request, from 0. */
  attempt: number;
  lane?: RequestLane;
} & MessageOptions;

/** The retry rule, without any I/O, so every platform makes the same call. */
export function decideBusy(input: BusyInput): BusyDecision {
  const { status, body, attempt } = input;
  if (status >= 200 && status < 300) return { action: 'success' };
  if (!BUSY_POLICY.busyStatuses.includes(status)) return { action: 'return' };
  const now = input.now ?? nowSeconds();
  const signal = busySignal(input.headers, now);
  if (status === 429 && isRefusal429(body, signal)) return { action: 'return' };
  const wait = busyWaitSeconds(signal, now);
  const backoff = (input.lane ?? 'foreground') === 'foreground' ? BUSY_POLICY.backoffSeconds : [];
  const canRetry = attempt < backoff.length && !signal.planLimitReached && (wait ?? 0) <= BUSY_POLICY.waitLimitSeconds;
  if (canRetry) return { action: 'retry', waitSeconds: Math.max(wait ?? 0, backoff[attempt]!) };
  if (status === 429) {
    return {
      action: 'fail',
      message: rateLimitMessage(input.provider, body, signal, { ...input, now }),
      cooldownSeconds: wait ?? BUSY_POLICY.defaultCooldownSeconds,
    };
  }
  return { action: 'fail', message: overloadedMessage(input.provider) };
}

/** Per-provider cooldowns. One instance per app (`busyCooldowns`) unless tests need their own. */
export class BusyCooldowns {
  private readonly limits = new Map<string, { until: number; message: string }>();

  /** Seconds left on `key`'s cooldown and the message it ended with. */
  get(key: string, now = nowSeconds()): { remainingSeconds: number; message: string } | undefined {
    const limit = this.limits.get(key);
    if (!limit) return undefined;
    if (limit.until <= now) {
      this.limits.delete(key);
      return undefined;
    }
    return { remainingSeconds: limit.until - now, message: limit.message };
  }

  /** Starts or extends a cooldown; a shorter one never cuts a longer one short. */
  record(key: string, seconds: number, message: string, now = nowSeconds()): void {
    const until = now + seconds;
    const existing = this.limits.get(key);
    if (!existing || existing.until < until) this.limits.set(key, { until, message });
  }

  clear(key: string): void {
    this.limits.delete(key);
  }
}

export const busyCooldowns = new BusyCooldowns();

/** Thrown when a provider stays busy past the retries, or is cooling down. The message is safe to show. */
export class ProviderBusyError extends Error {
  readonly retryAfterSeconds?: number;
  constructor(message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'ProviderBusyError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const sleep = (seconds: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, seconds * 1000);
  const abort = () => { clearTimeout(timer); reject(signal!.reason); };
  signal?.addEventListener('abort', abort, { once: true });
});

/** True when `error` is a dropped connection (a reset socket), which a fresh connection usually fixes. */
export function isLostConnection(error: unknown): boolean {
  const codes = ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED'];
  for (let current = error, depth = 0; current && typeof current === 'object' && depth < 4; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && codes.includes(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Runs `send`, and again (after `BUSY_POLICY.lostConnectionRetrySeconds`) while the connection drops. */
export async function retryingLostConnection<T>(
  send: () => Promise<T>,
  options: { delaysSeconds?: readonly number[]; isLost?: (error: unknown) => boolean; signal?: AbortSignal } = {},
): Promise<T> {
  const delays = options.delaysSeconds ?? BUSY_POLICY.lostConnectionRetrySeconds;
  const isLost = options.isLost ?? isLostConnection;
  for (let attempt = 0; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      if (!isLost(error) || attempt >= delays.length || options.signal?.aborted) throw error;
      await sleep(delays[attempt]!, options.signal);
    }
  }
}

export type SendRetryingOptions = {
  provider: BusyProvider;
  /** Cooldown key; defaults to the provider name. */
  key?: string;
  lane?: RequestLane;
  cooldowns?: BusyCooldowns;
  signal?: AbortSignal;
  formatReset?: ResetFormatter;
  /** For tests: replaces the real wait. */
  wait?: (seconds: number) => Promise<void>;
};

/**
 * Sends the request `send` makes through the busy rules: waits out a short cooldown (foreground only),
 * asks again when the provider is busy, and starts a cooldown when a rate limit outlasts the retries.
 * Returns the response for success and for any failure that is not busy (build its message with
 * `providerErrorMessage`); throws `ProviderBusyError` when the provider stays busy.
 */
export async function sendRetryingWhenBusy(send: () => Promise<Response>, options: SendRetryingOptions): Promise<Response> {
  const key = options.key ?? options.provider.name;
  const cooldowns = options.cooldowns ?? busyCooldowns;
  const lane = options.lane ?? 'foreground';
  const wait = options.wait ?? ((seconds: number) => sleep(seconds, options.signal));
  const cooling = cooldowns.get(key);
  if (cooling) {
    if (lane === 'background' || cooling.remainingSeconds > BUSY_POLICY.waitLimitSeconds) {
      throw new ProviderBusyError(cooling.message, cooling.remainingSeconds);
    }
    await wait(cooling.remainingSeconds);
  }
  for (let attempt = 0; ; attempt++) {
    const response = await retryingLostConnection(send, { signal: options.signal });
    if (response.ok) {
      cooldowns.clear(key);
      return response;
    }
    if (!BUSY_POLICY.busyStatuses.includes(response.status)) return response;
    const body = await response.clone().text().catch(() => '');
    const decision = decideBusy({ provider: options.provider, status: response.status, headers: response.headers, body, attempt, lane, formatReset: options.formatReset });
    switch (decision.action) {
      case 'success':
      case 'return':
        return response;
      case 'retry':
        await response.body?.cancel().catch(() => undefined);
        await wait(decision.waitSeconds);
        continue;
      case 'fail':
        if (decision.cooldownSeconds !== undefined) cooldowns.record(key, decision.cooldownSeconds, decision.message);
        throw new ProviderBusyError(decision.message, decision.cooldownSeconds);
    }
  }
}
