/**
 * Official "Sign in with ChatGPT" plan usage for a browser page, with no relay and no TLS engine.
 * The same flow as `@byos/chatgpt-local` and ByosCore Swift (what Skim uses): the first sign-in
 * registers the app as the user's own agent (`client_id=dynamic_agent_client`), OpenAI issues a
 * per-account client id, and inference goes to the public Responses API at api.openai.com.
 * https://developers.openai.com/siwc/token-sharing-open-source
 *
 * OpenAI only redirects to a `127.0.0.1` loopback address, which a website cannot listen on, so the
 * completion is paste-back: after approving, the browser lands on a page that cannot load and the
 * user copies that page's address into the app (the same shape as the Claude paste-code sign-in).
 *
 * TOKEN RULE: every request here goes from the browser straight to OpenAI (`auth.openai.com` for the
 * code exchange and refresh, `api.openai.com` for models and inference). Both answer browser origins.
 * Nothing passes through the host's server. The credential string lives only in the site's vault.
 * Paid or remotely hosted use is governed by OpenAI's eligibility rules; this adapter grants none.
 */
import { createCredentialRefresher, type ByosProvider, type CatalogModel, type ChatEvent, type ChatMessage, type ChatRequest, type ReasoningEffort, type SignInMethod } from '@byos/core';
import { CodexRequestError, readCodexStream } from './responses.js';
import { isRecord } from './sign-in.js';

export const CHATGPT_PLAN_ISSUER = 'https://auth.openai.com';
export const CHATGPT_PLAN_AUTHORIZE_URL = `${CHATGPT_PLAN_ISSUER}/api/accounts/authorize`;
export const CHATGPT_PLAN_TOKEN_URL = `${CHATGPT_PLAN_ISSUER}/api/accounts/oauth/token`;
export const CHATGPT_PLAN_RESOURCE = 'https://api.openai.com/v1';
export const CHATGPT_PLAN_RESPONSES_URL = `${CHATGPT_PLAN_RESOURCE}/responses`;
export const CHATGPT_PLAN_MODELS_URL = `${CHATGPT_PLAN_RESOURCE}/models`;
export const CHATGPT_PLAN_REGISTRATION_CLIENT_ID = 'dynamic_agent_client';
export const CHATGPT_PLAN_USAGE_SCOPE = 'chatgpt.tokens.use.direct';
export const CHATGPT_PLAN_SCOPE = `openid profile email offline_access resource.invoke ${CHATGPT_PLAN_USAGE_SCOPE}`;
/** OpenAI accepts only a `127.0.0.1` loopback callback (`localhost` is refused). Nothing listens here. */
export const CHATGPT_PLAN_REDIRECT_URI = 'http://127.0.0.1:1455/auth/callback';
/** Where the user raises or checks the plan allowance they share with apps. */
export const CHATGPT_PLAN_USAGE_SETTINGS_URL = 'https://chatgpt.com/settings/usage';

const CREDENTIAL_PREFIX = 'chatgpt-plan:';
const ATTEMPT_PREFIX = 'chatgpt-plan-attempt:';
const ATTEMPT_TTL_MS = 20 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_CHARS = 1_000_000;
const MAX_REQUEST_BYTES = 15 * 1024 * 1024;
const REFRESH_WINDOW_MS = 2 * 60_000;
const EFFORTS = new Set<ReasoningEffort>(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const DEAD_GRANT = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);

export type ChatGptPlanFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type ChatGptPlanCredential = { accessToken: string; refreshToken?: string; clientId: string; expiresAt: number; label?: string };
export type ChatGptPlanAttempt = {
  verifier: string; state: string; nonce: string; redirectUri: string; createdAt: number;
  /** The issued client id of a returning account; absent for a first registration. */
  clientId?: string;
};

/** Fixed text only; never anything OpenAI said. `code` tells a host what to do next. */
export class ChatGptPlanAuthError extends Error {
  readonly status: number;
  readonly code: 'failed' | 'declined' | 'pasted' | 'expired' | 'registration-reset' | 'plan-not-granted';
  constructor(code: ChatGptPlanAuthError['code'] = 'failed', message = 'ChatGPT sign-in could not be completed. Try connecting again.', status = 502) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = 'ChatGptPlanAuthError';
  }
}

export class ChatGptPlanReconnectRequiredError extends Error {
  readonly status = 401;
  /** True when OpenAI no longer knows the issued client id: the host should forget it. */
  readonly registrationReset: boolean;
  constructor(message = 'Your ChatGPT sign-in expired. Connect it again.', registrationReset = false) {
    super(message);
    this.registrationReset = registrationReset;
    this.name = 'ChatGptPlanReconnectRequiredError';
  }
}

function validText(value: unknown, maxLength = 16_384): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !/[\s\u0000-\u001f\u007f]/.test(value);
}

function toBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const textToBase64url = (text: string) => toBase64url(new TextEncoder().encode(text));
function base64urlToText(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - padded.length % 4) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
}
function jwtClaims(token: string | undefined): Record<string, unknown> | undefined {
  const segment = token?.split('.')[1];
  if (!segment) return undefined;
  try { const claims: unknown = JSON.parse(base64urlToText(segment)); return isRecord(claims) ? claims : undefined; } catch { return undefined; }
}

function linkedSignal(parent?: AbortSignal): AbortSignal {
  return AbortSignal.any([...(parent ? [parent] : []), AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
}

async function readJson(response: Response, limit: number): Promise<Record<string, unknown> | undefined> {
  try {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > limit) return undefined;
    const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
    return isRecord(payload) ? payload : undefined;
  } catch { return undefined; }
}

/** One opaque string for the site's vault. */
export function encodeChatGptPlanCredential(credential: ChatGptPlanCredential): string {
  return `${CREDENTIAL_PREFIX}${textToBase64url(JSON.stringify(credential))}`;
}

/** Accepts only the prefixed form, so a Codex device-code credential is never mistaken for one. */
export function decodeChatGptPlanCredential(value: string | undefined | null): ChatGptPlanCredential | undefined {
  if (!value || !value.startsWith(CREDENTIAL_PREFIX)) return undefined;
  try {
    const payload: unknown = JSON.parse(base64urlToText(value.slice(CREDENTIAL_PREFIX.length)));
    if (!isRecord(payload) || !validText(payload.accessToken) || !validText(payload.clientId, 512)) return undefined;
    if (payload.clientId === CHATGPT_PLAN_REGISTRATION_CLIENT_ID) return undefined;
    if (typeof payload.expiresAt !== 'number' || !Number.isFinite(payload.expiresAt)) return undefined;
    return {
      accessToken: payload.accessToken,
      ...(validText(payload.refreshToken) ? { refreshToken: payload.refreshToken } : {}),
      clientId: payload.clientId,
      expiresAt: payload.expiresAt,
      ...(typeof payload.label === 'string' && payload.label.length > 0 && payload.label.length <= 320 ? { label: payload.label } : {}),
    };
  } catch { return undefined; }
}

export function isChatGptPlanRecord(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.startsWith(CREDENTIAL_PREFIX);
}

/**
 * What OpenAI asks an install to keep across sign-outs: a stable host id (`ext_agent_host_id`) and
 * the client id it issued. Neither is a secret or grants access on its own. `storage` is usually
 * `localStorage`; with storage unavailable the values last for the page.
 */
export function createChatGptPlanRegistration(options: { prefix: string; storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> }) {
  const memory = new Map<string, string>();
  const storage = options.storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
  const read = (key: string) => { try { return storage?.getItem(options.prefix + key) || memory.get(key) || ''; } catch { return memory.get(key) || ''; } };
  const write = (key: string, value: string) => {
    if (value) memory.set(key, value); else memory.delete(key);
    try { if (value) storage?.setItem(options.prefix + key, value); else storage?.removeItem(options.prefix + key); } catch { /* kept for this page */ }
  };
  return {
    hostId(): string {
      const saved = read('host-id');
      if (/^urn:uuid:[0-9a-f-]{36}$/.test(saved)) return saved;
      const made = `urn:uuid:${crypto.randomUUID()}`;
      write('host-id', made);
      return made;
    },
    clientId(): string | undefined {
      const saved = read('client-id');
      return validText(saved, 512) && saved !== CHATGPT_PLAN_REGISTRATION_CLIENT_ID ? saved : undefined;
    },
    saveClientId(value: string) { write('client-id', value); },
    forgetClientId() { write('client-id', ''); },
  };
}
export type ChatGptPlanRegistration = ReturnType<typeof createChatGptPlanRegistration>;

async function authorizeUrl(attempt: ChatGptPlanAttempt, hostId: string, appName: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(attempt.verifier));
  const params: Record<string, string> = {
    response_type: 'code',
    client_id: attempt.clientId ?? CHATGPT_PLAN_REGISTRATION_CLIENT_ID,
    redirect_uri: attempt.redirectUri,
    scope: CHATGPT_PLAN_SCOPE,
    resource: CHATGPT_PLAN_RESOURCE,
    state: attempt.state,
    nonce: attempt.nonce,
    code_challenge: toBase64url(new Uint8Array(digest)),
    code_challenge_method: 'S256',
    // Every sign-in names this install, returning ones included.
    ext_agent_host_id: hostId,
  };
  if (!attempt.clientId) params.agent_name_hint = appName;
  // encodeURIComponent, not URLSearchParams: OpenAI reads a "+" as a space only when it is literal.
  return `${CHATGPT_PLAN_AUTHORIZE_URL}?${Object.entries(params).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}`;
}

/**
 * Step 1: the OpenAI authorization URL to open and the one-time attempt the host keeps until step 2.
 * `clientId` is the saved issued client id of a returning account (omit to register).
 */
export async function beginChatGptPlanSignIn(
  options: { appName: string; hostId: string; clientId?: string },
  now = Date.now(),
): Promise<{ url: string; attempt: ChatGptPlanAttempt }> {
  const appName = options.appName.trim();
  if (!appName || appName.length > 64) throw new TypeError('appName must be 1 to 64 characters.');
  if (!validText(options.hostId, 128)) throw new TypeError('hostId is required.');
  const random = (bytes: number) => toBase64url(crypto.getRandomValues(new Uint8Array(bytes)));
  const attempt: ChatGptPlanAttempt = {
    verifier: random(32), state: random(24), nonce: random(24), redirectUri: CHATGPT_PLAN_REDIRECT_URI, createdAt: now,
    ...(options.clientId && options.clientId !== CHATGPT_PLAN_REGISTRATION_CLIENT_ID ? { clientId: options.clientId } : {}),
  };
  return { url: await authorizeUrl(attempt, options.hostId, appName), attempt };
}

/** The URL for an attempt already in flight, for "open ChatGPT again". */
export function chatGptPlanSignInUrl(attempt: ChatGptPlanAttempt, options: { appName: string; hostId: string }): Promise<string> {
  return authorizeUrl(attempt, options.hostId, options.appName.trim());
}

/** One opaque string so a host can keep the attempt across a reload (session storage). */
export function encodeChatGptPlanAttempt(attempt: ChatGptPlanAttempt): string {
  return `${ATTEMPT_PREFIX}${textToBase64url(JSON.stringify(attempt))}`;
}

export function decodeChatGptPlanAttempt(value: string | undefined | null): ChatGptPlanAttempt | undefined {
  if (!value || !value.startsWith(ATTEMPT_PREFIX) || value.length > 4096) return undefined;
  try {
    const payload: unknown = JSON.parse(base64urlToText(value.slice(ATTEMPT_PREFIX.length)));
    if (!isRecord(payload)) return undefined;
    const pkce = (text: unknown): text is string => typeof text === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(text);
    if (!pkce(payload.verifier) || !pkce(payload.state) || !pkce(payload.nonce)) return undefined;
    if (payload.redirectUri !== CHATGPT_PLAN_REDIRECT_URI || typeof payload.createdAt !== 'number' || !Number.isFinite(payload.createdAt)) return undefined;
    return {
      verifier: payload.verifier, state: payload.state, nonce: payload.nonce, redirectUri: CHATGPT_PLAN_REDIRECT_URI, createdAt: payload.createdAt,
      ...(validText(payload.clientId, 512) ? { clientId: payload.clientId } : {}),
    };
  } catch { return undefined; }
}

export type ChatGptPlanCallback = { code: string; clientId: string } | { error: 'missing' | 'state-mismatch' | 'declined' | 'failed' | 'no-client' };

/**
 * Reads what the user pasted: the whole address of the page ChatGPT sent them to
 * (`http://127.0.0.1:1455/auth/callback?code=...&state=...`), just its query string, or the text of
 * the browser's error page that quotes it.
 */
export function readChatGptPlanCallback(pasted: string, attempt: Pick<ChatGptPlanAttempt, 'state' | 'clientId'>): ChatGptPlanCallback {
  if (!pasted.trim() || pasted.length > 16_384) return { error: 'missing' };
  // People copy this from an address bar, or from the text of the browser's "can't connect" page,
  // which wraps the address across lines and puts it in quotes inside a sentence. Take the address
  // out of whatever surrounds it: drop line breaks, then keep the run of URL characters after "?".
  const text = pasted.replace(/\s*[\r\n]+\s*/g, '').trim();
  const start = text.search(/[?&]?(?:code|state|error|client_id|scope|iss)=/);
  if (start < 0) return { error: 'missing' };
  const marked = text.lastIndexOf('?', start);
  const from = marked >= 0 && !/\s/.test(text.slice(marked, start)) ? marked + 1 : start;
  const query = (/^[A-Za-z0-9\-._~%!$&'()*+,;=:@/?]*/.exec(text.slice(from).replace(/^[?&]/, ''))?.[0] ?? '').replace(/['.,;:)]+$/, '');
  let params: URLSearchParams;
  try { params = new URLSearchParams(query); } catch { return { error: 'missing' }; }
  if (!params.has('state') || (!params.has('code') && !params.has('error'))) return { error: 'missing' };
  if (['state', 'code', 'client_id', 'error'].some(key => params.getAll(key).length > 1)) return { error: 'failed' };
  if (params.get('state') !== attempt.state) return { error: 'state-mismatch' };
  if (params.has('error')) return { error: params.get('error') === 'access_denied' ? 'declined' : 'failed' };
  const code = params.get('code');
  if (!validText(code, 4096)) return { error: 'missing' };
  // A new registration returns the issued client id; a returning account keeps its own.
  const issued = params.get('client_id') || undefined;
  if (issued && attempt.clientId && issued !== attempt.clientId) return { error: 'state-mismatch' };
  const clientId = issued ?? attempt.clientId;
  if (!validText(clientId, 512) || clientId === CHATGPT_PLAN_REGISTRATION_CLIENT_ID) return { error: 'no-client' };
  return { code, clientId };
}

const CALLBACK_MESSAGES = {
  missing: "Paste the whole address of the page ChatGPT sent you to. It starts with http://127.0.0.1.",
  'state-mismatch': 'That address is from a different sign-in. Open ChatGPT again, approve, and copy the new address.',
  declined: 'ChatGPT sign-in was declined. Start again and approve to connect.',
  failed: 'ChatGPT sign-in could not be completed. Try connecting again.',
  'no-client': "ChatGPT didn't return a client id. Start the sign-in again.",
} as const;

async function postToken(fetcher: ChatGptPlanFetch, fields: Record<string, string>, signal?: AbortSignal): Promise<Response> {
  return fetcher(CHATGPT_PLAN_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
    signal: linkedSignal(signal),
  });
}

function credentialFromTokens(value: Record<string, unknown>, clientId: string, previous: ChatGptPlanCredential | undefined, now: number): ChatGptPlanCredential {
  const refreshToken = value.refresh_token === undefined ? previous?.refreshToken : value.refresh_token;
  if (!validText(value.access_token) || (refreshToken !== undefined && !validText(refreshToken))) throw new ChatGptPlanAuthError();
  const expiresIn = typeof value.expires_in === 'number' && Number.isFinite(value.expires_in) && value.expires_in > 0 ? Math.min(value.expires_in, 365 * 24 * 3600) : 3600;
  const email = jwtClaims(typeof value.id_token === 'string' ? value.id_token : undefined)?.email;
  const label = typeof email === 'string' && email.length > 0 && email.length <= 320 ? email : previous?.label;
  return { accessToken: value.access_token, ...(refreshToken ? { refreshToken } : {}), clientId, expiresAt: now + expiresIn * 1000, ...(label ? { label } : {}) };
}

/**
 * Checks the ID token's issuer, audience, nonce and expiry, and that plan usage was granted. The
 * token comes straight from OpenAI's token endpoint over TLS, which OpenID Connect Core 3.1.3.7
 * accepts in place of a signature check (OpenAI's key set is not readable from a browser origin).
 */
function validateSignIn(tokens: Record<string, unknown>, clientId: string, nonce: string, now: number): void {
  const claims = jwtClaims(typeof tokens.id_token === 'string' ? tokens.id_token : undefined);
  if (!claims) throw new ChatGptPlanAuthError('failed', "ChatGPT didn't confirm who signed in. Sign in again.");
  const audience = typeof claims.aud === 'string' ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
  const issuer = typeof claims.iss === 'string' ? claims.iss.replace(/\/+$/, '') : '';
  const expiry = typeof claims.exp === 'number' ? claims.exp : 0;
  if (issuer !== CHATGPT_PLAN_ISSUER || !audience.includes(clientId) || claims.nonce !== nonce || expiry * 1000 <= now - 60_000) {
    throw new ChatGptPlanAuthError('failed', "ChatGPT's sign-in didn't check out. Sign in again.");
  }
  const accessScope = jwtClaims(typeof tokens.access_token === 'string' ? tokens.access_token : undefined)?.scope;
  const granted = typeof tokens.scope === 'string' ? tokens.scope : typeof accessScope === 'string' ? accessScope : '';
  if (!granted.split(/[ +]/).includes(CHATGPT_PLAN_USAGE_SCOPE)) {
    throw new ChatGptPlanAuthError('plan-not-granted', 'ChatGPT signed you in without plan usage. Start again and allow this app to use your plan.', 403);
  }
}

/**
 * Step 2: the user pastes the address ChatGPT sent them to. Returns the encoded credential for the
 * vault and the issued client id for the host to keep (`ChatGptPlanRegistration.saveClientId`).
 * Throws ChatGptPlanAuthError with a fixed message; on `pasted` errors the host keeps the attempt so
 * the user can paste again, and on `registration-reset` it forgets the saved client id.
 */
export async function completeChatGptPlanSignIn(
  attempt: ChatGptPlanAttempt,
  pasted: string,
  options: { fetch?: ChatGptPlanFetch; signal?: AbortSignal; now?: number } = {},
): Promise<{ credential: string; clientId: string; label?: string }> {
  const now = options.now ?? Date.now();
  if (now - attempt.createdAt > ATTEMPT_TTL_MS || now < attempt.createdAt) throw new ChatGptPlanAuthError('expired', 'This sign-in expired. Start again.', 400);
  const read = readChatGptPlanCallback(pasted, attempt);
  if ('error' in read) {
    throw new ChatGptPlanAuthError(read.error === 'declined' ? 'declined' : read.error === 'failed' || read.error === 'no-client' ? 'failed' : 'pasted', CALLBACK_MESSAGES[read.error], 400);
  }
  let response: Response;
  try {
    response = await postToken(options.fetch ?? fetch, {
      grant_type: 'authorization_code',
      client_id: read.clientId,
      code: read.code,
      code_verifier: attempt.verifier,
      redirect_uri: attempt.redirectUri,
      resource: CHATGPT_PLAN_RESOURCE,
    }, options.signal);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ChatGptPlanAuthError();
  }
  const payload = await readJson(response, MAX_RESPONSE_BYTES);
  if (!response.ok) {
    const error = typeof payload?.error === 'string' ? payload.error : '';
    if (error === 'invalid_client' || DEAD_GRANT.has(error)) {
      // The saved registration is gone, or the code was already used: the next sign-in starts clean.
      throw new ChatGptPlanAuthError(error === 'invalid_client' ? 'registration-reset' : 'expired',
        error === 'invalid_client' ? 'Your ChatGPT connection was reset. Sign in again.' : 'That sign-in address was already used or expired. Start again.', response.status);
    }
    throw new ChatGptPlanAuthError('failed', undefined, response.status);
  }
  if (!payload) throw new ChatGptPlanAuthError();
  validateSignIn(payload, read.clientId, attempt.nonce, now);
  const credential = credentialFromTokens(payload, read.clientId, undefined, now);
  return { credential: encodeChatGptPlanCredential(credential), clientId: read.clientId, ...(credential.label ? { label: credential.label } : {}) };
}

export function chatGptPlanNeedsRefresh(credential: ChatGptPlanCredential, now = Date.now()): boolean {
  return credential.expiresAt - now <= REFRESH_WINDOW_MS;
}

/** Trades the refresh grant for a new credential (OpenAI rotates the refresh token). */
export async function refreshChatGptPlanCredential(fetcher: ChatGptPlanFetch, current: ChatGptPlanCredential, signal?: AbortSignal, now = Date.now()): Promise<string> {
  if (!validText(current.refreshToken)) throw new ChatGptPlanReconnectRequiredError();
  let response: Response;
  try {
    response = await postToken(fetcher, { grant_type: 'refresh_token', client_id: current.clientId, refresh_token: current.refreshToken, resource: CHATGPT_PLAN_RESOURCE }, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChatGptPlanAuthError();
  }
  const payload = await readJson(response, MAX_RESPONSE_BYTES);
  if (!response.ok) {
    const error = typeof payload?.error === 'string' ? payload.error : '';
    if (error === 'invalid_client') throw new ChatGptPlanReconnectRequiredError(undefined, true);
    if (DEAD_GRANT.has(error) || response.status === 401) throw new ChatGptPlanReconnectRequiredError();
    throw new ChatGptPlanAuthError('failed', undefined, response.status);
  }
  if (!payload) throw new ChatGptPlanAuthError();
  return encodeChatGptPlanCredential(credentialFromTokens(payload, current.clientId, current, now));
}

/**
 * The Responses body for plan usage: system messages become `instructions`, the rest the
 * conversation. Plan usage refuses sampling and length fields, so none are sent; `store: false`
 * keeps turns off the account's history. `webSearch` adds OpenAI's built-in `web_search` tool, the one
 * hosted tool plan usage documents as supported.
 */
export function buildChatGptPlanBody(model: string, messages: ChatMessage[], effort?: ReasoningEffort, webSearch = false): Record<string, unknown> {
  if (!model || model.length > 128 || /\s/.test(model)) throw new CodexRequestError('Choose a valid ChatGPT model first.');
  const instructions = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const input = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role,
    content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: m.content }],
  }));
  const chars = instructions.length + messages.reduce((n, m) => n + m.content.length, 0);
  if (chars > MAX_PROMPT_CHARS || !input.length) throw new CodexRequestError('This ChatGPT request is too large.');
  return {
    model, instructions, input, store: false, stream: true,
    // OpenAI's own web search runs on its side under the user's plan (subject to account policy).
    ...(webSearch ? { tools: [{ type: 'web_search' }], tool_choice: 'auto' } : {}),
    ...(effort && effort !== 'none' && EFFORTS.has(effort) ? { reasoning: { effort } } : {}),
  };
}

const PLAN_MESSAGES: Record<string, (app: string) => string> = {
  subscription_sharing_usage_limit_exceeded: app => `Your ChatGPT plan's limit for ${app} is used up. Raise it in ChatGPT's usage settings or wait for it to reset.`,
  subscription_sharing_user_not_eligible: () => "This ChatGPT account's plan can't be used in other apps. Plus and Pro plans can.",
  subscription_sharing_usage_unavailable: () => 'ChatGPT plan usage is unavailable right now. Try again shortly.',
  subscription_sharing_user_unavailable: () => 'ChatGPT plan usage is unavailable right now. Try again shortly.',
  subscription_sharing_not_enabled: () => 'ChatGPT plan usage is not allowed for this app yet. Connect ChatGPT again and allow it.',
};
const RECONNECT_CODES = new Set(['subscription_sharing_invalid_user', 'chatpass_v2_scope_not_authorized', 'chatpass_v2_invalid_authorization_context', 'insufficient_scope']);

/** Fixed sentences only: OpenAI's own error text never reaches the page. */
async function requestError(response: Response, appName: string, what: string): Promise<Error> {
  const payload = await readJson(response, MAX_RESPONSE_BYTES);
  const error = isRecord(payload?.error) ? payload.error : payload;
  const code = typeof error?.code === 'string' ? error.code : typeof error?.type === 'string' ? error.type : '';
  if (RECONNECT_CODES.has(code)) return new ChatGptPlanReconnectRequiredError('ChatGPT needs you to sign in again. Connect it again.');
  const known = PLAN_MESSAGES[code];
  // Not 401/403: hosts read those as "reconnect", and a plan limit or ineligible plan is not that.
  if (known) return new CodexRequestError(known(appName), code.endsWith('limit_exceeded') ? 429 : 0);
  if (response.status === 401) return new ChatGptPlanReconnectRequiredError('ChatGPT rejected this sign-in. Connect it again.');
  if (response.status === 429) return new CodexRequestError(PLAN_MESSAGES.subscription_sharing_usage_limit_exceeded(appName), 429);
  if (response.status === 403) return new CodexRequestError('This ChatGPT account cannot use the selected model.', 403);
  if (response.status >= 500) return new CodexRequestError('ChatGPT is temporarily unavailable. Try again shortly.', response.status);
  return new CodexRequestError(`ChatGPT ${what} failed (${response.status}).`, response.status);
}

/** Parses `/v1/models` as plan usage returns it (`models` rows with a slug) or as the API does (`data` rows with an id). */
export function parseChatGptPlanModels(raw: unknown): CatalogModel[] {
  if (!isRecord(raw)) return [];
  const rows = Array.isArray(raw.models) ? raw.models : Array.isArray(raw.data) ? raw.data : [];
  const seen = new Set<string>();
  const models: CatalogModel[] = [];
  for (const entry of rows) {
    if (!isRecord(entry)) continue;
    const id = typeof (entry.slug ?? entry.id) === 'string' ? String(entry.slug ?? entry.id).trim() : '';
    if (!id || id.length > 128 || /\s/.test(id) || seen.has(id.toLowerCase())) continue;
    // Plan rows say where a model belongs; only `list` rows are meant for a picker.
    if (entry.visibility !== undefined && entry.visibility !== 'list') continue;
    const reasoningEfforts: Array<{ effort: ReasoningEffort; description?: string }> = [];
    for (const level of Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : []) {
      if (!isRecord(level) || !EFFORTS.has(level.effort as ReasoningEffort) || reasoningEfforts.some(e => e.effort === level.effort)) continue;
      reasoningEfforts.push(typeof level.description === 'string' && level.description.trim()
        ? { effort: level.effort as ReasoningEffort, description: level.description.trim() }
        : { effort: level.effort as ReasoningEffort });
    }
    const def = EFFORTS.has(entry.default_reasoning_level as ReasoningEffort) ? entry.default_reasoning_level as ReasoningEffort : undefined;
    const name = typeof entry.display_name === 'string' && entry.display_name.trim() ? entry.display_name.trim().slice(0, 256) : id;
    models.push({ id, name, ...(reasoningEfforts.length ? { reasoningEfforts } : {}), ...(def ? { defaultReasoningEffort: def } : {}) });
    seen.add(id.toLowerCase());
  }
  return models;
}

export type ChatGptPlanProviderOptions = {
  /** Named in plan-limit messages ("Your ChatGPT plan's limit for <appName> is used up"). */
  appName: string;
  /** The credential as the vault holds it now (another tab may have refreshed it). */
  readCredential: () => string | null | undefined;
  /** Saves a refreshed credential in the same place. */
  saveCredential: (value: string) => void;
  /** Site-specific suffix for the cross-tab Web Lock. */
  namespace?: string;
  /** Called when OpenAI no longer knows the issued client id, so the host can forget it. */
  onRegistrationReset?: () => void;
  /** Defaults to the page's own `fetch`: requests go straight to OpenAI. */
  fetch?: ChatGptPlanFetch;
  /** Shown when the site does not offer plan sign-in. */
  unavailableReason?: () => string | undefined;
};

/**
 * `chatgptPlan()`: a ByosProvider for a ChatGPT plan through the official Sign in with ChatGPT.
 * The token handed to listModels/stream is the encoded credential from `completeChatGptPlanSignIn`.
 * Chat plus OpenAI's web search (`ChatRequest.webSearch`); no other hosted tools exist on plan usage.
 */
export function chatgptPlan(options: ChatGptPlanProviderOptions): ByosProvider {
  const send: ChatGptPlanFetch = (input, init) => (options.fetch ?? fetch)(input, init);
  // One refresh at a time per browser: OpenAI rotates the refresh grant.
  const refresher = createCredentialRefresher({
    lockName: `byos-chatgpt-plan-refresh:${options.namespace?.trim() || 'default'}`,
    readCredential: options.readCredential,
    saveCredential: options.saveCredential,
    reconnectError: () => new ChatGptPlanReconnectRequiredError(),
  });
  async function refreshed(token: string, force: boolean, signal?: AbortSignal): Promise<ChatGptPlanCredential> {
    const current = decodeChatGptPlanCredential(token);
    if (!current) throw new ChatGptPlanReconnectRequiredError();
    if (!force && !chatGptPlanNeedsRefresh(current)) return current;
    if (!current.refreshToken) {
      if (force) throw new ChatGptPlanReconnectRequiredError();
      return current;
    }
    let value: string;
    try { value = await refresher.refreshed(token, () => refreshChatGptPlanCredential(send, current), signal); }
    catch (error) {
      if (error instanceof ChatGptPlanReconnectRequiredError && error.registrationReset) options.onRegistrationReset?.();
      throw error;
    }
    const next = decodeChatGptPlanCredential(value);
    if (!next) throw new ChatGptPlanReconnectRequiredError();
    return next;
  }
  /** Sends with the current credential; on 401 refreshes once and sends again. */
  async function authorized(token: string, signal: AbortSignal | undefined, request: (credential: ChatGptPlanCredential) => Promise<Response>) {
    let credential = await refreshed(token, false, signal);
    let response = await request(credential);
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      credential = await refreshed(options.readCredential() || token, true, signal);
      response = await request(credential);
    }
    return { credential, response };
  }

  async function* stream(token: string, request: ChatRequest): AsyncGenerator<ChatEvent> {
    const serialized = JSON.stringify(buildChatGptPlanBody(request.model, request.messages, request.effort, request.webSearch));
    if (new TextEncoder().encode(serialized).byteLength > MAX_REQUEST_BYTES) throw new CodexRequestError('This ChatGPT request is too large.');
    const { credential, response } = await authorized(token, request.signal, current => send(CHATGPT_PLAN_RESPONSES_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${current.accessToken}`, Accept: 'text/event-stream', 'Content-Type': 'application/json' },
      body: serialized,
      credentials: 'omit',
      redirect: 'error',
      signal: request.signal,
    }));
    if (!response.ok) throw await requestError(response, options.appName, 'request');
    yield* readCodexStream(response, [token, credential.accessToken, credential.refreshToken ?? ''], request.signal);
  }

  async function listModels(token: string, signal?: AbortSignal): Promise<CatalogModel[]> {
    const { response } = await authorized(token, signal, current => send(CHATGPT_PLAN_MODELS_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${current.accessToken}`, Accept: 'application/json' },
      credentials: 'omit', cache: 'no-store', redirect: 'error', signal,
    }));
    if (!response.ok) throw await requestError(response, options.appName, 'model list request');
    const models = parseChatGptPlanModels(await readJson(response, MAX_CATALOG_BYTES));
    if (!models.length) throw new CodexRequestError('ChatGPT listed no models this account can use.');
    return models;
  }

  return {
    id: 'chatgpt',
    displayName: 'ChatGPT',
    signIn: [{ kind: 'pkce', handshakeViaSite: false, completion: 'paste-code' }] satisfies SignInMethod[],
    webSearch: true,
    availability: () => {
      const reason = options.unavailableReason?.();
      return reason ? { available: false, reason } : { available: true };
    },
    listModels,
    stream,
  };
}
