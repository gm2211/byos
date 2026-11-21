import {
  CLAUDE_CODE_SYSTEM_PREFIX,
  CLAUDE_OAUTH_BETA,
  claudeEmptyResponseMessage,
  shapeClaudeBody,
  createCredentialRefresher,
  type ApiKeySetupStep,
  type ByosProvider,
  type CatalogModel,
  type ChatEvent,
  type ChatRequest,
  type ReasoningEffort,
  type SignInMethod,
  type WebSource,
} from '@byos/core';
import {
  claudeNeedsRefresh,
  ClaudeReconnectRequiredError,
  decodeClaudeCredential,
  isClaudeSubscriptionRecord,
  refreshClaudeCredential,
  type ClaudeCredential,
  type ClaudeTokenFetch,
} from './claude-sign-in.js';
import { ProviderRequestError, safeProviderErrorText, sendProviderRequest } from './chat.js';
import { friendlyModelName } from '@byos/core';
import { iterateSseEvents } from './sse.js';

/**
 * Claude (Anthropic) adapter. Talks to api.anthropic.com with an API key (`x-api-key`) or, for a
 * Claude Pro/Max subscription token (`sk-ant-oat…`), with a Bearer header, the OAuth beta flags and the
 * Claude Code system block that such tokens require. Browsers can send those: api.anthropic.com allows
 * Bearer calls from pages. Only Anthropic's token endpoint refuses browsers, so:
 *
 * - In a browser, pass `subscription` (a `claudeTokenRelayFetch` for the host's token relay plus where
 *   the vault keeps the credential) and `signIn` offers the paste-code flow (`beginClaudeSignIn` /
 *   `completeClaudeSignIn`). The credential is the encoded `claude-subscription:` string; this adapter
 *   refreshes it near expiry (single-flight, cross-tab) and once more after a 401.
 * - In Node/native, subscription sign-in is `@byos/claude-local` (Keychain, loopback OAuth with a paste
 *   fallback); this adapter then only spends a raw `sk-ant-oat` token it is handed.
 *
 * `subscriptionsPaused` is an opt-in policy gate for hosts that must refuse subscription tokens
 * (`CLAUDE_SUBSCRIPTIONS_PAUSED_NOTE`). It is off by default: subscription sign-in is supported.
 *
 * PLAN CREDITS. Claude Max and Team plans include monthly Claude API credits
 * (https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers). They land in a linked
 * Claude Console organization and are spent by ordinary API keys, so the sign-in links to the claim
 * page and the key page.
 *
 * TOKEN RULE: the credential goes only to api.anthropic.com. Claude exception (approved 2026-11-01):
 * the code exchange and each refresh grant pass through the host's fixed-destination token relay
 * (the token endpoint blocks browsers); the relay neither stores nor logs them.
 */
export const ANTHROPIC_POLICY_URL = 'https://code.claude.com/docs/en/legal-and-compliance';
export const CLAUDE_PLAN_CREDITS_URL = 'https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers';
/** Where a user gets a key: claim Max/Team plan credits (optional), then create the key. */
export const CLAUDE_API_KEY_SETUP: ApiKeySetupStep[] = [
  { label: 'Claim your Max or Team plan’s API credits (optional)', url: 'https://claude.ai/settings/billing' },
  { label: 'Create an API key in Claude Console', url: 'https://platform.claude.com/settings/keys' },
];
export const CLAUDE_SUBSCRIPTIONS_PAUSED_NOTE = 'This app has paused Claude subscription sign-in. Use an API key, or pick another service.';
/** Beta flags and system block a subscription Bearer token needs (defined in @byos/core). */
export { CLAUDE_OAUTH_BETA, CLAUDE_CODE_SYSTEM_PREFIX };

const API = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
const EFFORT_ORDER: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const MAX_PAGES = 5;

/** Anything that is not an `sk-ant-api…` key is a subscription (OAuth) credential. */
export function isClaudeSubscriptionCredential(raw: string): boolean {
  const token = raw.trim();
  return Boolean(token) && !(token.startsWith('sk-ant-') && !token.startsWith('sk-ant-oat'));
}

export function claudeCredentialAllowed(raw: string, subscriptionsPaused = false): boolean {
  return !(subscriptionsPaused && isClaudeSubscriptionCredential(raw));
}

/**
 * How a request reaches api.anthropic.com: `fetch` from the page, or a host transport (the browser-TLS
 * `claude-api` tunnel, `createCodexTlsFetch`) whose calls carry no browser Origin.
 */
export type ClaudeTransport = (input: string, init: RequestInit) => Promise<Response>;

function headers(key: string, json: boolean, tunnelled = false): Record<string, string> {
  const subscription = isClaudeSubscriptionCredential(key);
  return {
    ...(subscription ? { Authorization: `Bearer ${key.trim()}`, 'anthropic-beta': CLAUDE_OAUTH_BETA } : { 'x-api-key': key }),
    'anthropic-version': ANTHROPIC_VERSION,
    // Anthropic requires this opt-in for calls made straight from a browser page (not through a tunnel).
    ...(tunnelled ? {} : { 'anthropic-dangerous-direct-browser-access': 'true' }),
    ...(json ? { 'content-type': 'application/json' } : {}),
  };
}

/**
 * Anthropic's refusal of a call made from a web page: a 401 whose message says CORS requests are not
 * allowed for the organization. For Claude plan accounts it is intermittent (Motive measured
 * 2026-09-26 that the same account is allowed moments later; tracked hit it on a fresh sign-in
 * 2026-11-20), so it is not an expired sign-in: retried after short waits, never answered with a
 * token renewal. Ported from Motive's web/src/anthropic.ts.
 */
export const CLAUDE_BROWSER_ACCESS_RETRY_DELAYS_MS: readonly number[] = [400, 1200, 3000, 6000];
const BROWSER_ACCESS_DENIED = 'CORS requests are not allowed for this Organization';
export const CLAUDE_BROWSER_ACCESS_DENIED_NOTE = 'Anthropic is turning down calls from this web page for your Claude account. Disconnect Claude and connect it again; if it still happens, try again in a few minutes.';

/** The browser-access refusal after every retry: the credential is fine, so hosts must not treat it as expired. */
export class ClaudeBrowserAccessDeniedError extends ProviderRequestError {
  constructor(message = CLAUDE_BROWSER_ACCESS_DENIED_NOTE) {
    super(message, 401);
    this.name = 'ClaudeBrowserAccessDeniedError';
  }
}

export function isClaudeBrowserAccessDenied(status: number, payload: unknown): boolean {
  if (status !== 401) return false;
  const message = (payload as { error?: { message?: unknown } } | null | undefined)?.error?.message;
  return typeof message === 'string' && message.includes(BROWSER_ACCESS_DENIED);
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); return; }
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * fetch() to api.anthropic.com that asks again after the browser-access refusal, waiting
 * `delays` between tries, and throws ClaudeBrowserAccessDeniedError if every try is refused. A 401
 * means the model never ran, so asking again cannot bill twice. Any other answer is returned as is.
 */
export async function fetchClaudeRetryingBrowserAccess(
  send: () => Promise<Response>,
  signal?: AbortSignal,
  delays: readonly number[] = CLAUDE_BROWSER_ACCESS_RETRY_DELAYS_MS,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await send();
    if (response.status !== 401) return response;
    const payload = await response.clone().json().catch(() => undefined);
    if (!isClaudeBrowserAccessDenied(response.status, payload)) return response;
    await response.body?.cancel().catch(() => undefined);
    if (attempt >= delays.length) throw new ClaudeBrowserAccessDeniedError();
    await abortableDelay(delays[attempt], signal);
  }
}

type AnthropicModelRow = {
  id?: unknown;
  display_name?: unknown;
  capabilities?: { effort?: Record<string, unknown> & { supported?: unknown } };
};

/** One page of GET /v1/models to picker rows, with each model's supported effort levels. */
export function parseAnthropicModels(rows: unknown): CatalogModel[] {
  if (!Array.isArray(rows)) return [];
  const models: CatalogModel[] = [];
  for (const raw of rows as AnthropicModelRow[]) {
    if (!raw || typeof raw.id !== 'string' || !raw.id.trim() || /\s/.test(raw.id)) continue;
    const effort = raw.capabilities?.effort;
    const efforts = effort && effort.supported === true
      ? EFFORT_ORDER.filter(level => (effort[level] as { supported?: unknown } | undefined)?.supported === true)
      : [];
    models.push({
      id: raw.id,
      name: typeof raw.display_name === 'string' && raw.display_name.trim() ? raw.display_name : friendlyModelName(raw.id),
      ...(efforts.length ? { reasoningEfforts: efforts.map(level => ({ effort: level })) } : {}),
    });
  }
  return models;
}

function requireKey(key: string, paused: boolean): void {
  if (!claudeCredentialAllowed(key, paused)) throw new ProviderRequestError(CLAUDE_SUBSCRIPTIONS_PAUSED_NOTE, 403);
}

export async function listClaudeModels(key: string, signal?: AbortSignal, subscriptionsPaused = false, transport?: ClaudeTransport): Promise<CatalogModel[]> {
  const send: ClaudeTransport = transport ?? ((input, init) => fetch(input, init));
  requireKey(key, subscriptionsPaused);
  const models: CatalogModel[] = [];
  let after = '';
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = `${API}/models?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;
    const response = await fetchClaudeRetryingBrowserAccess(() => send(url, { headers: headers(key, false, Boolean(transport)), signal, redirect: 'error' }), signal);
    const payload = await response.json().catch(() => ({})) as { data?: unknown; has_more?: unknown; last_id?: unknown };
    if (!response.ok) throw new ProviderRequestError(safeProviderErrorText(payload, key) ?? `Claude model list failed (${response.status}).`, response.status);
    models.push(...parseAnthropicModels(payload.data));
    if (payload.has_more !== true || typeof payload.last_id !== 'string') break;
    after = payload.last_id;
  }
  return models;
}

/** Anthropic's server-side web search tool version sent when `ChatRequest.webSearch` is set. */
export const CLAUDE_WEB_SEARCH_TOOL = 'web_search_20250305';

/** `web_search_result` entries and `web_search_result_location` citations as sources; anything else
 * (an error object, an unknown shape) is skipped, so a format change shows fewer sources, never throws. */
function claudeWebSources(items: unknown[], seen: Set<string>): WebSource[] {
  const sources: WebSource[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const { type, url, title } = item as { type?: unknown; url?: unknown; title?: unknown };
    if (type !== 'web_search_result' && type !== 'web_search_result_location') continue;
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    sources.push({ url, title: typeof title === 'string' && title.trim() ? title.trim() : url });
  }
  return sources;
}

/** Streams POST /v1/messages as ChatEvents. System messages become the top-level `system`. */
export async function* streamClaude(key: string, request: ChatRequest, subscriptionsPaused = false, transport?: ClaudeTransport): AsyncGenerator<ChatEvent> {
  const send: ClaudeTransport = transport ?? ((input, init) => fetch(input, init));
  requireKey(key, subscriptionsPaused);
  const userSystem = request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
  const subscription = isClaudeSubscriptionCredential(key);
  // @byos/core's Claude rules (ported from Skim): the Claude Code block opens a subscription's system
  // prompt (without it Anthropic answers a bare 429), and a chosen effort turns on adaptive thinking
  // with room to answer after it.
  const body = shapeClaudeBody({
    model: request.model,
    messages: request.messages.filter(message => message.role !== 'system').map(({ role, content }) => ({ role, content })),
    instructions: userSystem,
    subscription,
    maxTokens: 16_000,
    effort: request.effort,
    stream: true,
    // Anthropic's server-side search tool: Anthropic runs the searches and bills the key or plan.
    tools: request.webSearch ? [{ type: CLAUDE_WEB_SEARCH_TOOL, name: 'web_search', max_uses: 5 }] : undefined,
  });
  // Chat keeps the model's own sampling and, unless an effort was chosen, its own thinking default:
  // 16k tokens leave room to answer, so the low-effort rule for small budgets isn't needed here.
  delete body.temperature;
  if (!request.effort) delete body.output_config;
  if (body.system === '') delete body.system;
  const response = await sendProviderRequest(() => fetchClaudeRetryingBrowserAccess(() => send(`${API}/messages`, {
    method: 'POST',
    signal: request.signal,
    redirect: 'error',
    headers: headers(key, true, Boolean(transport)),
    body: JSON.stringify(body),
  }), request.signal), {
    provider: { name: 'Claude', credential: subscription ? 'subscription' : 'api-key', sharedLimitNote: subscription ? 'Claude.ai and Claude Code count toward the same limit.' : undefined },
    lane: request.lane,
    signal: request.signal,
    secrets: [key],
  });
  if (!response.body) throw new ProviderRequestError('Claude sent an empty response. Try again.', response.status);
  let wroteText = false;
  let stopReason: string | undefined;
  let inputTokens: number | undefined;
  const seen = new Set<string>();
  const searches = new Map<unknown, string>();
  const reader = response.body.getReader();
  try {
    for await (const event of iterateSseEvents(reader)) {
      if (event.type !== 'data') continue;
      let data: {
        type?: string;
        index?: unknown;
        delta?: { type?: string; text?: unknown; thinking?: unknown; citation?: unknown; partial_json?: unknown; stop_reason?: unknown };
        content_block?: { type?: unknown; content?: unknown; name?: unknown };
        message?: { usage?: { input_tokens?: unknown } };
        usage?: { output_tokens?: unknown };
        error?: unknown;
      };
      try { data = JSON.parse(event.data); } catch { continue; }
      if (data.type === 'error') throw new ProviderRequestError(safeProviderErrorText(data, key) ?? 'Claude stopped with an error.', 200);
      if (data.type === 'message_start' && typeof data.message?.usage?.input_tokens === 'number') inputTokens = data.message.usage.input_tokens;
      // A search Claude starts is a server_tool_use block whose input (the query) streams as JSON.
      if (data.type === 'content_block_start' && data.content_block?.type === 'server_tool_use' && data.content_block.name === 'web_search') searches.set(data.index, '');
      if (data.type === 'content_block_delta' && data.delta?.type === 'input_json_delta' && searches.has(data.index) && typeof data.delta.partial_json === 'string') {
        searches.set(data.index, (searches.get(data.index) ?? '') + data.delta.partial_json);
      }
      if (data.type === 'content_block_stop' && searches.has(data.index)) {
        let query: unknown;
        try { query = (JSON.parse(searches.get(data.index) || '{}') as { query?: unknown }).query; } catch { /* no query shown */ }
        searches.delete(data.index);
        yield typeof query === 'string' && query.trim() ? { type: 'search', query: query.trim().slice(0, 400) } : { type: 'search' };
      }
      // A finished search arrives whole as a web_search_tool_result block (or its error object).
      if (data.type === 'content_block_start' && data.content_block?.type === 'web_search_tool_result') {
        const results = data.content_block.content;
        if (Array.isArray(results)) for (const source of claudeWebSources(results, seen)) yield { type: 'source', source };
      }
      if (data.type === 'content_block_delta') {
        if (data.delta?.type === 'text_delta' && typeof data.delta.text === 'string') { if (data.delta.text) wroteText = true; yield { type: 'text', text: data.delta.text }; }
        if (data.delta?.type === 'thinking_delta' && typeof data.delta.thinking === 'string') yield { type: 'reasoning', text: data.delta.thinking };
        if (data.delta?.type === 'citations_delta') for (const source of claudeWebSources([data.delta.citation], seen)) yield { type: 'source', source };
      }
      if (data.type === 'message_delta' && typeof data.delta?.stop_reason === 'string') stopReason = data.delta.stop_reason;
      if (data.type === 'message_delta' && typeof data.usage?.output_tokens === 'number') {
        yield { type: 'usage', inputTokens, outputTokens: data.usage.output_tokens };
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* A pending read releases it when settled. */ }
  }
  // No text at all: say why when Claude did (out of room, declined) instead of showing nothing.
  if (!wroteText) throw new ProviderRequestError(claudeEmptyResponseMessage(stopReason), 200);
  yield { type: 'done' };
}

const API_KEY_METHOD: SignInMethod = {
  kind: 'api-key',
  hint: 'A Claude API key from platform.claude.com. Max and Team plans include monthly API credits for it.',
  setup: CLAUDE_API_KEY_SETUP,
};

export type ClaudeSubscriptionOptions = {
  /** `claudeTokenRelayFetch({ path })`: how refresh grants reach Anthropic's token endpoint. */
  tokenFetch: ClaudeTokenFetch;
  /** The credential as the vault holds it now (another tab may have refreshed it). */
  readCredential: () => string | null | undefined;
  /** Saves a refreshed credential in the same place. */
  saveCredential: (value: string) => void;
  /** Site-specific suffix for the cross-tab Web Lock. */
  namespace?: string;
  /**
   * How plan-token calls (Messages, the model list) reach api.anthropic.com. Anthropic refuses plan
   * tokens on calls from a web page ("CORS requests are not allowed for this Organization"), so a
   * browser host passes its browser-TLS fetch (`createCodexTlsFetch`, relay destination `claude-api`):
   * the page runs TLS itself and the host relays ciphertext only. API keys still go by `fetch`.
   */
  apiFetch?: ClaudeTransport;
};

export type ClaudeProviderOptions = {
  subscriptionsPaused?: boolean;
  /** Browser subscription sign-in and refresh. Without it only API keys and raw issued tokens are offered. */
  subscription?: ClaudeSubscriptionOptions;
};

export function claude(options: ClaudeProviderOptions = {}): ByosProvider {
  const paused = options.subscriptionsPaused ?? false;
  const subscription = options.subscription;
  const refresher = subscription && createCredentialRefresher({
    lockName: `byos-claude-refresh:${subscription.namespace?.trim() || 'default'}`,
    readCredential: () => subscription.readCredential(),
    saveCredential: value => subscription.saveCredential(value),
    reconnectError: () => new ClaudeReconnectRequiredError(),
  });

  /** A plan sign-in's calls go through the host's tunnel when it has one; API keys go by fetch. */
  const transportFor = (token: string): ClaudeTransport | undefined =>
    subscription?.apiFetch && isClaudeSubscriptionRecord(token) ? subscription.apiFetch : undefined;

  /** The string to send as the key: an encoded record becomes its (refreshed) access token. */
  async function accessToken(token: string, force: boolean, signal?: AbortSignal): Promise<string> {
    requireKey(token, paused);
    if (!isClaudeSubscriptionRecord(token)) return token;
    const current: ClaudeCredential | undefined = decodeClaudeCredential(token);
    if (!current) throw new ClaudeReconnectRequiredError();
    const expired = current.expiresAt <= Date.now();
    if (!force && !claudeNeedsRefresh(current)) return current.accessToken;
    if (!subscription || !refresher || !current.refreshToken) {
      if (force || expired) throw new ClaudeReconnectRequiredError();
      return current.accessToken;
    }
    const value = await refresher.refreshed(token, () => refreshClaudeCredential(subscription.tokenFetch, current), signal);
    const next = decodeClaudeCredential(value);
    if (!next) throw new ClaudeReconnectRequiredError();
    return next.accessToken;
  }

  /** One forced refresh and retry when Anthropic answers 401 before anything was produced. */
  async function withRetry<T>(token: string, signal: AbortSignal | undefined, run: (key: string) => Promise<T>): Promise<T> {
    const key = await accessToken(token, false, signal);
    try { return await run(key); }
    catch (error) {
      if (!(error instanceof ProviderRequestError) || error instanceof ClaudeBrowserAccessDeniedError || error.status !== 401 || !isClaudeSubscriptionRecord(token)) throw error;
      return run(await accessToken(subscription?.readCredential() || token, true, signal));
    }
  }

  return {
    id: 'claude',
    displayName: 'Claude',
    signIn: subscription && !paused
      ? [{ kind: 'pkce', handshakeViaSite: true, completion: 'paste-code' }, API_KEY_METHOD]
      : [API_KEY_METHOD],
    availability: () => ({ available: true }),
    webSearch: true,
    listModels: (token, signal) => withRetry(token, signal, key => listClaudeModels(key, signal, paused, transportFor(token))),
    async *stream(token, request) {
      const key = await accessToken(token, false, request.signal);
      const first = streamClaude(key, request, paused, transportFor(token));
      let started = false;
      try {
        for await (const event of first) { started = true; yield event; }
        return;
      } catch (error) {
        if (started || !(error instanceof ProviderRequestError) || error instanceof ClaudeBrowserAccessDeniedError || error.status !== 401 || !isClaudeSubscriptionRecord(token)) throw error;
      }
      const retryKey = await accessToken(subscription?.readCredential() || token, true, request.signal);
      yield* streamClaude(retryKey, request, paused, transportFor(token));
    },
  };
}

/** Which Claude models take a `temperature` field. Lives in @byos/core (claude-request) with the rest
 *  of the Claude request rules; re-exported here for existing callers. */
export { claudeAcceptsTemperature } from '@byos/core';
