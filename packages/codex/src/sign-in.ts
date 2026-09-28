/**
 * ChatGPT (Codex) subscription sign-in: OpenAI's device-code flow, run in the browser over the
 * browser-owned TLS fetch from @byos/browser-tls. Ported from Motive's web/src/codex-connect.ts
 * (same endpoints, client id, validation and limits); storage is left to the site, which keeps the
 * encoded credential in its @byos/core vault.
 *
 * TOKEN RULE: every request here goes through `fetch` (the TLS-in-page fetch), so the site's relay
 * only ever sees ciphertext. The returned credential string lives only in the browser.
 */

export type CodexFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export const AUTH_ORIGIN = 'https://auth.openai.com';
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_DEVICE_PAGE = `${AUTH_ORIGIN}/codex/device`;
const CREDENTIAL_PREFIX = 'codex-subscription:';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_DEVICE_LIFETIME_SECONDS = 900;

export type CodexDeviceStart = { deviceAuthId: string; userCode: string; verificationUri: string; expiresAt: number; interval: number };
export type CodexCredential = { accessToken: string; refreshToken?: string; idToken?: string; accountId?: string; expiresAt?: number };
export type CodexDevicePoll = { pending: true } | { pending: false; credential: string };

export class CodexAuthError extends Error {
  readonly status: number;
  constructor(status = 502, message = 'ChatGPT sign-in could not be completed. Try connecting again.') {
    super(message);
    this.status = status;
    this.name = 'CodexAuthError';
  }
}

export class CodexReconnectRequiredError extends Error {
  constructor(message = 'Your ChatGPT sign-in expired. Connect it again.') {
    super(message);
    this.name = 'CodexReconnectRequiredError';
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validText(value: unknown, maxLength = 16_384): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && value.trim() === value
    && !/[\s\u0000-\u001f\u007f]/.test(value);
}

function linkedSignal(parent?: AbortSignal): AbortSignal {
  return AbortSignal.any([...(parent ? [parent] : []), AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new CodexAuthError(response.status);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => undefined); throw new CodexAuthError(response.status); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new CodexAuthError(response.status); }
  if (!isRecord(payload)) throw new CodexAuthError(response.status);
  return payload;
}

async function post(fetch: CodexFetch, path: string, body: string, contentType: string, signal?: AbortSignal): Promise<Response> {
  return fetch(new URL(path, AUTH_ORIGIN), {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
    redirect: 'error',
    credentials: 'omit',
    signal: linkedSignal(signal),
  });
}

function decodeJwtPayload(token: string | undefined): Record<string, unknown> | undefined {
  if (!token) return undefined;
  try {
    const segment = token.split('.')[1];
    if (!segment) return undefined;
    return JSON.parse(atob(segment.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
  } catch { return undefined; }
}

function accountIdFromJwt(token: string | undefined): string | undefined {
  const auth = decodeJwtPayload(token)?.['https://api.openai.com/auth'];
  const value = isRecord(auth) ? auth.chatgpt_account_id ?? auth.account_id : undefined;
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\r\n]/.test(value) ? value : undefined;
}

export function codexAccountId(credential: CodexCredential): string | undefined {
  return credential.accountId ?? accountIdFromJwt(credential.idToken) ?? accountIdFromJwt(credential.accessToken);
}

function base64url(text: string): string {
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** One opaque string for the site's vault. A bare access token (no prefix) is also accepted. */
export function encodeCodexCredential(credential: CodexCredential): string {
  return `${CREDENTIAL_PREFIX}${base64url(JSON.stringify(credential))}`;
}

export function decodeCodexCredential(value: string | undefined | null): CodexCredential | undefined {
  if (!value) return undefined;
  if (!value.startsWith(CREDENTIAL_PREFIX)) return validText(value) ? { accessToken: value } : undefined;
  try {
    const encoded = value.slice(CREDENTIAL_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
    const payload: unknown = JSON.parse(atob(encoded + '='.repeat((4 - encoded.length % 4) % 4)));
    if (!isRecord(payload) || !validText(payload.accessToken)) return undefined;
    return {
      accessToken: payload.accessToken,
      ...(validText(payload.refreshToken) ? { refreshToken: payload.refreshToken } : {}),
      ...(validText(payload.idToken) ? { idToken: payload.idToken } : {}),
      ...(validText(payload.accountId, 512) ? { accountId: payload.accountId } : {}),
      ...(typeof payload.expiresAt === 'number' && Number.isFinite(payload.expiresAt) ? { expiresAt: payload.expiresAt } : {}),
    };
  } catch { return undefined; }
}

function credentialFromTokens(value: Record<string, unknown>, previous?: CodexCredential, now = Date.now()): CodexCredential {
  const refreshToken = value.refresh_token === undefined ? previous?.refreshToken : value.refresh_token;
  if (!validText(value.access_token) || !validText(refreshToken)) throw new CodexAuthError();
  if (value.id_token !== undefined && !validText(value.id_token)) throw new CodexAuthError();
  if (value.account_id !== undefined && !validText(value.account_id, 512)) throw new CodexAuthError();
  const expiresIn = value.expires_in;
  if (expiresIn !== undefined && (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0)) throw new CodexAuthError();
  const jwtExp = decodeJwtPayload(value.access_token)?.exp;
  const expiresAt = typeof expiresIn === 'number'
    ? now + Math.min(expiresIn, 365 * 24 * 3600) * 1000
    : typeof jwtExp === 'number' && Number.isFinite(jwtExp) && jwtExp > 0 ? jwtExp * 1000 : now + 30 * 60 * 1000;
  const idToken = typeof value.id_token === 'string' ? value.id_token : previous?.idToken;
  const credential: CodexCredential = { accessToken: value.access_token, refreshToken, expiresAt, ...(idToken ? { idToken } : {}) };
  const accountId = (typeof value.account_id === 'string' ? value.account_id : undefined) ?? previous?.accountId ?? codexAccountId(credential);
  return accountId ? { ...credential, accountId } : credential;
}

/** Step 1: ask OpenAI for a one-time code the driver approves on OpenAI's own page. */
export async function startCodexDeviceSignIn(fetch: CodexFetch, signal?: AbortSignal): Promise<CodexDeviceStart> {
  const response = await post(fetch, '/api/accounts/deviceauth/usercode', JSON.stringify({ client_id: CODEX_CLIENT_ID }), 'application/json', signal);
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new CodexAuthError(response.status); }
  const payload = await readJsonObject(response);
  const deviceAuthId = payload.device_auth_id;
  const userCode = payload.user_code ?? payload.usercode;
  if (!validText(deviceAuthId, 2_048) || !validText(userCode, 128)) throw new CodexAuthError();
  const interval = Number(payload.interval);
  const expiresIn = Number(payload.expires_in);
  return {
    deviceAuthId,
    userCode,
    verificationUri: CODEX_DEVICE_PAGE,
    expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? Math.min(expiresIn, MAX_DEVICE_LIFETIME_SECONDS) : MAX_DEVICE_LIFETIME_SECONDS) * 1000,
    interval: Number.isFinite(interval) && interval > 0 ? Math.min(Math.max(interval, 3), MAX_DEVICE_LIFETIME_SECONDS) : 5,
  };
}

/** Step 2, repeated every `interval` seconds: pending until approved, then the encoded credential. */
export async function pollCodexDeviceSignIn(fetch: CodexFetch, start: Pick<CodexDeviceStart, 'deviceAuthId' | 'userCode'>, signal?: AbortSignal): Promise<CodexDevicePoll> {
  if (!validText(start.deviceAuthId, 2_048) || !validText(start.userCode, 128)) throw new CodexAuthError();
  const poll = await post(fetch, '/api/accounts/deviceauth/token',
    JSON.stringify({ device_auth_id: start.deviceAuthId, user_code: start.userCode }), 'application/json', signal);
  if (poll.status === 403 || poll.status === 404) { await poll.body?.cancel().catch(() => undefined); return { pending: true }; }
  if (!poll.ok) { await poll.body?.cancel().catch(() => undefined); throw new CodexAuthError(poll.status); }
  const authorization = await readJsonObject(poll);
  if (!validText(authorization.authorization_code) || !validText(authorization.code_verifier)) throw new CodexAuthError();
  const tokens = await post(fetch, '/oauth/token', new URLSearchParams({
    grant_type: 'authorization_code',
    code: authorization.authorization_code,
    code_verifier: authorization.code_verifier,
    redirect_uri: `${AUTH_ORIGIN}/deviceauth/callback`,
    client_id: CODEX_CLIENT_ID,
  }).toString(), 'application/x-www-form-urlencoded', signal);
  if (!tokens.ok) { await tokens.body?.cancel().catch(() => undefined); throw new CodexAuthError(tokens.status); }
  return { pending: false, credential: encodeCodexCredential(credentialFromTokens(await readJsonObject(tokens))) };
}

export function codexNeedsRefresh(credential: CodexCredential, now = Date.now()): boolean {
  return Boolean(credential.expiresAt && credential.expiresAt - now <= 5 * 60 * 1000);
}

/** Trades the refresh grant for a new credential (OpenAI rotates the refresh token). */
export async function refreshCodexCredential(fetch: CodexFetch, current: CodexCredential, signal?: AbortSignal): Promise<string> {
  if (!validText(current.refreshToken)) throw new CodexReconnectRequiredError();
  const response = await post(fetch, '/oauth/token', new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: current.refreshToken,
    client_id: CODEX_CLIENT_ID,
  }).toString(), 'application/x-www-form-urlencoded', signal);
  if ([400, 401, 403].includes(response.status)) { await response.body?.cancel().catch(() => undefined); throw new CodexReconnectRequiredError(); }
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new CodexAuthError(response.status); }
  const next = credentialFromTokens(await readJsonObject(response), current);
  const before = codexAccountId(current), after = codexAccountId(next);
  if (before && after && before !== after) throw new CodexReconnectRequiredError('The ChatGPT account changed. Connect it again.');
  return encodeCodexCredential(next);
}
