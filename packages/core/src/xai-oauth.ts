/**
 * xAI (Grok subscription) OAuth: constants, request builders and strict response parsers shared by
 * the browser sign-in (@byos/providers), the device-code broker (@byos/server) and the Node client
 * (@byos/grok-local). Pure functions only: no node: imports, so it runs in browsers.
 *
 * xAI has no public OAuth client for third-party apps; this is the public Grok CLI client's. The
 * endpoints, client id and scope are undocumented and can change. Live behavior is unverified:
 * only synthetic vectors (conformance/xai-oauth.json) exercise this module.
 *
 * TOKEN RULE: a Grok refresh grant never crosses a plaintext host relay. The browser sends it
 * inside browser TLS through the ciphertext `xai-auth` destination; Node and native clients call
 * auth.x.ai directly. The device-code broker is the existing one-time handshake exception.
 */
export const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
export const XAI_DEVICE_CODE_URL = 'https://auth.x.ai/oauth2/device/code';
export const XAI_TOKEN_URL = 'https://auth.x.ai/oauth2/token';
export const XAI_OAUTH_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
export const XAI_DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/** Refresh when the access token has less than this left. */
export const XAI_REFRESH_WINDOW_MS = 300_000;
/** Lifetime assumed when a token response omits a usable expires_in. */
export const XAI_DEFAULT_LIFETIME_SECONDS = 3600;
export const XAI_DEVICE_MAX_WAIT_SECONDS = 900;
export const XAI_DEVICE_DEFAULT_EXPIRES_SECONDS = 300;
export const XAI_SLOW_DOWN_SECONDS = 5;

const MAX_LIFETIME_SECONDS = 365 * 24 * 60 * 60;
const MAX_TOKEN_LENGTH = 32_768;

/** Structurally the same as the device-code broker's config (core cannot import @byos/server). */
export const XAI_DEVICE_CODE_CONFIG = {
  deviceCodeUrl: XAI_DEVICE_CODE_URL,
  tokenUrl: XAI_TOKEN_URL,
  clientId: XAI_OAUTH_CLIENT_ID,
  scope: XAI_OAUTH_SCOPE,
} as const;

/** Exactly the headers the browser-tls `xai-auth` destination allows; add nothing else. */
export const XAI_FORM_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  Accept: 'application/json',
} as const;

export type XaiTokenRequest =
  | { kind: 'device_start' }
  | { kind: 'device_code'; deviceCode: string }
  | { kind: 'refresh_token'; refreshToken: string };

/** Form fields in canonical order. */
export function xaiTokenRequestFields(request: XaiTokenRequest): Array<[string, string]> {
  switch (request.kind) {
    case 'device_start':
      return [['client_id', XAI_OAUTH_CLIENT_ID], ['scope', XAI_OAUTH_SCOPE]];
    case 'device_code':
      return [['grant_type', XAI_DEVICE_CODE_GRANT], ['client_id', XAI_OAUTH_CLIENT_ID], ['device_code', request.deviceCode]];
    case 'refresh_token':
      return [['grant_type', 'refresh_token'], ['refresh_token', request.refreshToken], ['client_id', XAI_OAUTH_CLIENT_ID]];
  }
}

export function xaiFormBody(request: XaiTokenRequest): string {
  return new URLSearchParams(xaiTokenRequestFields(request)).toString();
}

export function xaiTokenUrl(request: XaiTokenRequest): string {
  return request.kind === 'device_start' ? XAI_DEVICE_CODE_URL : XAI_TOKEN_URL;
}

export type XaiTokens = { accessToken: string; refreshToken?: string; idToken?: string; expiresAt: number };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function tokenText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TOKEN_LENGTH && !/[\u0000-\u001f\u007f]/.test(value);
}

function seconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Validates a token response. A missing refresh_token keeps `previousRefreshToken`; a missing or
 * non-positive expires_in means 3600s. Undefined without a usable access token.
 */
export function parseXaiTokenResponse(
  payload: unknown,
  options: { previousRefreshToken?: string; now: number },
): XaiTokens | undefined {
  if (!isPlainObject(payload) || !tokenText(payload.access_token)) return undefined;
  const lifetime = Math.min(seconds(payload.expires_in) ?? XAI_DEFAULT_LIFETIME_SECONDS, MAX_LIFETIME_SECONDS);
  const refreshToken = tokenText(payload.refresh_token) ? payload.refresh_token : options.previousRefreshToken;
  return {
    accessToken: payload.access_token,
    ...(refreshToken ? { refreshToken } : {}),
    ...(tokenText(payload.id_token) ? { idToken: payload.id_token } : {}),
    expiresAt: options.now + lifetime * 1000,
  };
}

export type XaiDeviceStart = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  intervalSeconds: number;
  expiresAt: number;
};

function safeHttpsUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048 || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}

/** Validates a device-authorization response; interval defaults to 5s, expires_in to 300s (capped at 900s). */
export function parseXaiDeviceStart(payload: unknown, now: number): XaiDeviceStart | undefined {
  if (!isPlainObject(payload)) return undefined;
  const { device_code: deviceCode, user_code: userCode, verification_uri: verificationUri, verification_uri_complete: complete } = payload;
  if (!tokenText(deviceCode) || !tokenText(userCode) || userCode.length > 256 || !safeHttpsUri(verificationUri)) return undefined;
  const interval = seconds(payload.interval);
  const expires = Math.min(seconds(payload.expires_in) ?? XAI_DEVICE_DEFAULT_EXPIRES_SECONDS, XAI_DEVICE_MAX_WAIT_SECONDS);
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(safeHttpsUri(complete) ? { verificationUriComplete: complete } : {}),
    intervalSeconds: Math.max(1, interval ?? 5),
    expiresAt: now + expires * 1000,
  };
}

export type XaiPollOutcome = 'pending' | 'slow_down' | 'declined' | 'expired' | 'failed';

/** Classifies a non-OK device-code poll answer by its OAuth `error` code. */
export function classifyXaiPollError(_status: number, body: unknown): XaiPollOutcome {
  const code = isPlainObject(body) && typeof body.error === 'string' ? body.error : '';
  switch (code) {
    case 'authorization_pending': return 'pending';
    case 'slow_down': return 'slow_down';
    case 'access_denied':
    case 'authorization_denied': return 'declined';
    case 'expired_token': return 'expired';
    default: return 'failed';
  }
}

/** 400 and 401 mean the grant is dead; everything else (403, 429, 5xx, network) may pass. */
export function classifyXaiRefreshFailure(status: number): 'reconnect' | 'transient' {
  return status === 400 || status === 401 ? 'reconnect' : 'transient';
}
