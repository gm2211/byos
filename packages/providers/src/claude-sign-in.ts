/**
 * Claude Pro/Max subscription sign-in for a browser: OAuth authorization code + PKCE with the
 * paste-code completion (the user approves on claude.ai, which shows a `CODE#STATE` string to copy
 * back). Runs on WebCrypto; storage is left to the site, which keeps the encoded credential in its
 * @byos/core vault. Modeled on the Codex sign-in in @byos/codex.
 *
 * TOKEN RULE (Claude exception, approved 2026-11-01): Anthropic's token endpoint blocks browser
 * origins (CORS), so the authorization-code exchange and each refresh grant go through the host's
 * fixed-destination token relay (`claudeTokenRelayFetch` here, `createClaudeTokenRelay` in
 * @byos/server). The relay neither stores nor logs them. The resulting credential lives only in the
 * browser and inference goes browser -> api.anthropic.com, which does allow Bearer calls from pages.
 * Live acceptance of the paste-code redirect URI is unverified.
 */
import {
  buildClaudeTokenRequest,
  claudeAuthorizeUrl,
  CLAUDE_PASTE_REDIRECT_URI,
  CLAUDE_TOKEN_URL,
  parseClaudePastedCode,
} from '@byos/core';

/** Always called with `CLAUDE_TOKEN_URL`; a host binding decides where the request really goes. */
export type ClaudeTokenFetch = (input: string, init: RequestInit) => Promise<Response>;

const CREDENTIAL_PREFIX = 'claude-subscription:';
const ATTEMPT_TTL_MS = 20 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_LIFETIME_SECONDS = 8 * 3600;
const REFRESH_WINDOW_MS = 5 * 60_000;

export type ClaudeCredential = { accessToken: string; refreshToken?: string; expiresAt: number; label?: string };
export type ClaudeSignInAttempt = { verifier: string; state: string; createdAt: number };

/** Fixed text only; never anything the provider or the relay said. */
export class ClaudeAuthError extends Error {
  readonly status: number;
  constructor(status = 502, message = 'Claude sign-in could not be completed. Try connecting again.') {
    super(message);
    this.status = status;
    this.name = 'ClaudeAuthError';
  }
}

export class ClaudeReconnectRequiredError extends Error {
  readonly status = 401;
  constructor(message = 'Your Claude sign-in expired. Connect it again.') {
    super(message);
    this.name = 'ClaudeReconnectRequiredError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validText(value: unknown, maxLength = 32_768): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !/[\s\u0000-\u001f\u007f]/.test(value);
}

function toBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function textToBase64url(text: string): string {
  return toBase64url(new TextEncoder().encode(text));
}

function base64urlToText(value: string): string {
  const encoded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(encoded + '='.repeat((4 - encoded.length % 4) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
}

function linkedSignal(parent?: AbortSignal): AbortSignal {
  return AbortSignal.any([...(parent ? [parent] : []), AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
}

/** One opaque string for the site's vault. */
export function encodeClaudeCredential(credential: ClaudeCredential): string {
  return `${CREDENTIAL_PREFIX}${textToBase64url(JSON.stringify(credential))}`;
}

/** Accepts only the prefixed form; a bare token is not a Claude subscription credential record. */
export function decodeClaudeCredential(value: string | undefined | null): ClaudeCredential | undefined {
  if (!value || !value.startsWith(CREDENTIAL_PREFIX)) return undefined;
  try {
    const payload: unknown = JSON.parse(base64urlToText(value.slice(CREDENTIAL_PREFIX.length)));
    if (!isRecord(payload) || !validText(payload.accessToken)) return undefined;
    if (typeof payload.expiresAt !== 'number' || !Number.isFinite(payload.expiresAt)) return undefined;
    return {
      accessToken: payload.accessToken,
      ...(validText(payload.refreshToken) ? { refreshToken: payload.refreshToken } : {}),
      expiresAt: payload.expiresAt,
      ...(typeof payload.label === 'string' && payload.label.length > 0 && payload.label.length <= 320 ? { label: payload.label } : {}),
    };
  } catch { return undefined; }
}

export function isClaudeSubscriptionRecord(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.startsWith(CREDENTIAL_PREFIX);
}

/**
 * The token fetch for a host that mounts `createClaudeTokenRelay` at `path` (the relay's token
 * route, same origin). Refuses to carry any URL but Anthropic's token endpoint, so the only thing
 * that ever crosses to the host is the grant body, to the host's own relay.
 */
export function claudeTokenRelayFetch(options: { path: string }): ClaudeTokenFetch {
  const path = options.path;
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[?#\\]/.test(path) || path.includes('//')) {
    throw new TypeError('path must be a same-origin absolute path with safe segments.');
  }
  const segments = path.slice(1).split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9._~-]+$/.test(segment))) {
    throw new TypeError('path must be a same-origin absolute path with safe segments.');
  }
  return (input, init) => {
    if (input !== CLAUDE_TOKEN_URL) return Promise.reject(new ClaudeAuthError());
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: init.body,
      signal: init.signal,
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
    });
  };
}

async function postGrant(tokenFetch: ClaudeTokenFetch, body: unknown, signal?: AbortSignal): Promise<Response> {
  return tokenFetch(CLAUDE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    credentials: 'omit',
    signal: linkedSignal(signal),
  });
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new ClaudeAuthError(response.status);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => undefined); throw new ClaudeAuthError(response.status); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new ClaudeAuthError(response.status); }
  if (!isRecord(payload)) throw new ClaudeAuthError(response.status);
  return payload;
}

function credentialFromTokens(value: Record<string, unknown>, previous?: ClaudeCredential, now = Date.now()): ClaudeCredential {
  if (!validText(value.access_token)) throw new ClaudeAuthError();
  if (value.refresh_token !== undefined && !validText(value.refresh_token)) throw new ClaudeAuthError();
  const refreshToken = typeof value.refresh_token === 'string' ? value.refresh_token : previous?.refreshToken;
  const expiresIn = typeof value.expires_in === 'number' && Number.isFinite(value.expires_in) && value.expires_in > 0
    ? Math.min(value.expires_in, 365 * 24 * 3600) : DEFAULT_LIFETIME_SECONDS;
  const account = value.account;
  const email = isRecord(account) && typeof account.email_address === 'string' && account.email_address.length > 0 && account.email_address.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(account.email_address) ? account.email_address : undefined;
  const label = email ?? previous?.label;
  return {
    accessToken: value.access_token,
    ...(refreshToken ? { refreshToken } : {}),
    expiresAt: now + expiresIn * 1000,
    ...(label ? { label } : {}),
  };
}

/** Step 1: build the claude.ai authorization URL and the one-time attempt the host keeps until step 2. */
export async function beginClaudeSignIn(now = Date.now()): Promise<{ url: string; attempt: ClaudeSignInAttempt }> {
  const verifier = toBase64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = toBase64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const url = claudeAuthorizeUrl({ challenge: toBase64url(new Uint8Array(digest)), state, redirectUri: CLAUDE_PASTE_REDIRECT_URI });
  return { url, attempt: { verifier, state, createdAt: now } };
}

/**
 * Step 2: the user pastes what claude.ai showed. Returns the encoded credential for the vault. Throws
 * ClaudeAuthError with a fixed message; the host keeps the attempt on error so the user can re-paste.
 */
export async function completeClaudeSignIn(
  tokenFetch: ClaudeTokenFetch,
  attempt: ClaudeSignInAttempt,
  pasted: string,
  signal?: AbortSignal,
  now = Date.now(),
): Promise<string> {
  if (now - attempt.createdAt > ATTEMPT_TTL_MS || now < attempt.createdAt) {
    throw new ClaudeAuthError(400, 'This sign-in expired. Start again.');
  }
  const code = parseClaudePastedCode(pasted, attempt.state);
  if (!code) throw new ClaudeAuthError(400, 'That code did not match. Copy all of it again.');
  let response: Response;
  try {
    response = await postGrant(tokenFetch, buildClaudeTokenRequest({
      kind: 'authorization_code', code, state: attempt.state, verifier: attempt.verifier, redirectUri: CLAUDE_PASTE_REDIRECT_URI,
    }), signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ClaudeAuthError();
  }
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new ClaudeAuthError(response.status); }
  return encodeClaudeCredential(credentialFromTokens(await readJsonObject(response), undefined, now));
}

export function claudeNeedsRefresh(credential: ClaudeCredential, now = Date.now()): boolean {
  return credential.expiresAt - now <= REFRESH_WINDOW_MS;
}

/** Trades the refresh grant for a new credential (the refresh token rotates; the old one is kept if none returns). */
export async function refreshClaudeCredential(tokenFetch: ClaudeTokenFetch, current: ClaudeCredential, signal?: AbortSignal): Promise<string> {
  if (!validText(current.refreshToken, 4096)) throw new ClaudeReconnectRequiredError();
  let response: Response;
  try { response = await postGrant(tokenFetch, buildClaudeTokenRequest({ kind: 'refresh_token', refreshToken: current.refreshToken }), signal); }
  catch (error) {
    if (signal?.aborted) throw error;
    throw new ClaudeAuthError();
  }
  if ([400, 401, 403].includes(response.status)) { await response.body?.cancel().catch(() => undefined); throw new ClaudeReconnectRequiredError(); }
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new ClaudeAuthError(); }
  return encodeClaudeCredential(credentialFromTokens(await readJsonObject(response), current));
}
