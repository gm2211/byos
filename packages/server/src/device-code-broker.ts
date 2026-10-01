/**
 * Device-code (RFC 8628) sign-in broker for providers whose OAuth endpoints refuse browser origins
 * (no CORS), so a site's server has to make the two token-endpoint calls on the browser's behalf.
 *
 * Token rule: the token set passes through once, in the response to the one poll that completes
 * approval, and is never stored, logged or cached here.
 *
 * Each attempt belongs to the browser that started it: `start()` hands that browser the provider's
 * device code as its `attemptId`, and `poll()` needs it back. The device code is provider-generated
 * and unguessable, and only its holder can collect the tokens, so no browser can poll another's
 * attempt. Because the browser holds the handle, a server restart or a second instance mid-approval
 * loses nothing. The broker keeps only a best-effort in-memory throttle so polls respect the
 * provider's interval. Send the id in a request header or body, never in a URL, because URLs end
 * up in access logs.
 */
import { createHash } from 'node:crypto';

export interface DeviceCodeProviderConfig {
  deviceCodeUrl: string;
  tokenUrl: string;
  clientId: string;
  scope: string;
}

export interface DeviceCodeBrokerOptions extends DeviceCodeProviderConfig {
  /** Cap on how long one attempt is tracked; the provider's own expires_in wins when shorter. */
  maxLifetimeMs?: number;
  /** Cap on throttle entries kept in memory; the oldest is dropped past it (polling still works). */
  maxPending?: number;
  fetch?: typeof fetch;
  now?: () => number;
  messages?: Partial<DeviceCodeMessages>;
}

export interface DeviceCodeMessages {
  /** A poll without a usable attempt id: usually a page loaded before this broker shipped. */
  missingAttempt: string;
  expired: string;
  declined: string;
  failed: string;
}

const DEFAULT_MESSAGES: DeviceCodeMessages = {
  missingAttempt: 'This sign-in attempt is no longer active. Reload the page and connect again.',
  expired: 'The device code expired. Start again.',
  declined: 'Authorization was declined in the browser.',
  failed: 'Authorization could not be completed. Try again.',
};

export interface DeviceCodeStart {
  attemptId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  interval: number;
  expiresAt: number;
}

export interface DeviceCodeTokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresIn?: number;
}

export interface DeviceCodeStatus {
  connected: boolean;
  pending: boolean;
  error?: string;
  /** Present exactly once, on the poll that completes approval. */
  tokens?: DeviceCodeTokens;
}

interface Throttle {
  intervalMs: number;
  expiresAt: number;
  lastPolledAt: number;
}

const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
// Device codes are opaque provider strings; accept URL-safe printable ones of sane length.
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9._~+\/=-]{8,512}$/;

export function isDeviceCodeAttemptId(value: unknown): value is string {
  return typeof value === 'string' && ATTEMPT_ID_PATTERN.test(value);
}

const MAX_VERIFICATION_URI_LENGTH = 2_048;

function isSafeVerificationUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_VERIFICATION_URI_LENGTH
    || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}

export function createDeviceCodeBroker(options: DeviceCodeBrokerOptions) {
  const maxLifetimeMs = options.maxLifetimeMs ?? 15 * 60 * 1000;
  const maxPending = options.maxPending ?? 500;
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs <= 0) {
    throw new TypeError('maxLifetimeMs must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(maxPending) || maxPending <= 0) {
    throw new TypeError('maxPending must be a positive safe integer.');
  }
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = options.now ?? Date.now;
  const messages = { ...DEFAULT_MESSAGES, ...options.messages };
  const throttles = new Map<string, Throttle>();
  // Keyed by a hash so the map holds no usable device code.
  const keyFor = (deviceCode: string) => createHash('sha256').update(deviceCode).digest('base64url');

  const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

  function prune() {
    const at = now();
    for (const [key, throttle] of throttles) if (throttle.expiresAt < at) throttles.delete(key);
    // Map iteration is insertion order, so the first key is the oldest attempt.
    while (throttles.size >= maxPending) throttles.delete(throttles.keys().next().value as string);
  }

  async function start(): Promise<DeviceCodeStart> {
    let res: Response;
    try {
      res = await doFetch(options.deviceCodeUrl, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form({ client_id: options.clientId, scope: options.scope }),
      });
    } catch { throw new Error(messages.failed); }
    if (!res.ok) throw new Error(`Device code request failed (HTTP ${res.status}).`);
    let data: Record<string, unknown>;
    try { data = await res.json() as Record<string, unknown>; }
    catch { throw new Error('Device code provider returned an invalid response.'); }
    const deviceCode = typeof data.device_code === 'string' ? data.device_code : '';
    const userCode = typeof data.user_code === 'string' ? data.user_code : '';
    const verificationUri = typeof data.verification_uri === 'string' ? data.verification_uri : '';
    if (!deviceCode || !userCode || !verificationUri) {
      throw new Error('Device code response missing device_code, user_code, or verification_uri.');
    }
    const verificationUriComplete = typeof data.verification_uri_complete === 'string'
      ? data.verification_uri_complete
      : `${verificationUri}?user_code=${encodeURIComponent(userCode)}`;
    if (!isSafeVerificationUri(verificationUri) || !isSafeVerificationUri(verificationUriComplete)) {
      throw new Error('Device code provider returned an invalid verification link.');
    }
    const providerInterval = Number(data.interval ?? 5);
    if (!Number.isFinite(providerInterval) || providerInterval < 0 || providerInterval > maxLifetimeMs / 1000) {
      throw new Error('Device code provider returned an invalid polling interval.');
    }
    const interval = Math.max(3, providerInterval);
    const codeLifetimeSeconds = Number(data.expires_in ?? 0);
    if (data.expires_in !== undefined && (!Number.isFinite(codeLifetimeSeconds) || codeLifetimeSeconds <= 0)) {
      throw new Error('Device code provider returned an invalid expiration.');
    }
    const codeLifetimeMs = codeLifetimeSeconds * 1000;
    const expiresAt = now() + (codeLifetimeMs > 0 ? Math.min(codeLifetimeMs, maxLifetimeMs) : maxLifetimeMs);

    if (!isDeviceCodeAttemptId(deviceCode)) throw new Error('Device code response carried an unexpected device_code format.');
    prune();
    throttles.set(keyFor(deviceCode), { intervalMs: interval * 1000, expiresAt, lastPolledAt: 0 });
    return { attemptId: deviceCode, userCode, verificationUri, verificationUriComplete, interval, expiresAt };
  }

  /** Polls the provider for this browser's attempt, at most once per the provider's interval. A
   * missing or malformed id reports "nothing pending" with an error, so the page stops waiting. */
  async function poll(attemptId: unknown): Promise<DeviceCodeStatus> {
    if (!isDeviceCodeAttemptId(attemptId)) return { connected: false, pending: false, error: messages.missingAttempt };
    const deviceCode = attemptId;
    const key = keyFor(deviceCode);
    let throttle = throttles.get(key);
    if (!throttle) {
      // Unknown here (a restart, or another instance started it): the provider still knows it.
      prune();
      throttle = { intervalMs: 4_000, expiresAt: now() + maxLifetimeMs, lastPolledAt: 0 };
      throttles.set(key, throttle);
    }
    if (now() > throttle.expiresAt) {
      throttles.delete(key);
      return { connected: false, pending: false, error: messages.expired };
    }
    if (now() - throttle.lastPolledAt < throttle.intervalMs) return { connected: false, pending: true };
    throttle.lastPolledAt = now();

    let res: Response;
    try {
      res = await doFetch(options.tokenUrl, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form({ grant_type: DEVICE_CODE_GRANT, client_id: options.clientId, device_code: deviceCode }),
      });
    } catch {
      return { connected: false, pending: true };
    }
    const payload = await res.json().catch(() => ({})) as Record<string, unknown>;

    if (!res.ok) {
      const code = typeof payload.error === 'string' ? payload.error : '';
      if (code === 'authorization_pending') return { connected: false, pending: true };
      if (code === 'slow_down') {
        throttle.intervalMs = Math.min(throttle.intervalMs + 5_000, maxLifetimeMs);
        return { connected: false, pending: true };
      }
      throttles.delete(key);
      if (code === 'access_denied') return { connected: false, pending: false, error: messages.declined };
      if (code === 'expired_token') return { connected: false, pending: false, error: messages.expired };
      return { connected: false, pending: false, error: messages.failed };
    }

    // The device code is single-use whatever happens next.
    throttles.delete(key);
    const accessToken = typeof payload.access_token === 'string' ? payload.access_token : '';
    if (!accessToken) return { connected: false, pending: false, error: 'The provider approved the device but returned no access token.' };
    return {
      connected: true,
      pending: false,
      tokens: {
        accessToken,
        refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : undefined,
        idToken: typeof payload.id_token === 'string' ? payload.id_token : undefined,
        expiresIn: typeof payload.expires_in === 'number' ? payload.expires_in : undefined,
      },
    };
  }

  function cancel(attemptId: unknown): void {
    if (isDeviceCodeAttemptId(attemptId)) throttles.delete(keyFor(attemptId));
  }

  return { start, poll, cancel };
}

export type DeviceCodeBroker = ReturnType<typeof createDeviceCodeBroker>;
