/**
 * Claude Pro/Max subscription OAuth: the constants, the request shapes and the strict validators
 * shared by the browser sign-in (@byos/providers), the host token relay (@byos/server) and the Node
 * client (@byos/claude-local). Pure functions only: no node: imports, so it runs in browsers.
 *
 * The endpoints, client id and scope are the public Claude Code client's (CLI 2.1.316 embedded strings).
 * They are undocumented and can change; re-check with
 * `strings $(readlink -f $(which claude)) | grep oauth`. claude.com 307-redirects the authorize URL to
 * claude.ai; calling claude.ai/oauth/authorize directly now answers "Invalid request format".
 *
 * TOKEN RULE (Claude exception, approved 2026-11-01): the authorization-code exchange and each
 * refresh grant pass through the host's fixed-destination token relay, because the token endpoint
 * refuses browser origins (CORS). The relay neither stores nor logs them. Inference still goes
 * browser -> api.anthropic.com.
 */
export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const CLAUDE_AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
export const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
export const CLAUDE_OAUTH_SCOPE = 'user:profile user:inference';
/** platform.claude.com page that displays a `CODE#STATE` string for the user to copy back. Live acceptance is unverified. */
export const CLAUDE_PASTE_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
/** Beta flags a subscription Bearer token needs. */
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20,claude-code-20250219';
/** Subscription tokens are only honored for requests that open with this system block. */
export const CLAUDE_CODE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

export type ClaudeAuthorizeParams = { challenge: string; state: string; redirectUri: string };

export function claudeAuthorizeUrl(params: ClaudeAuthorizeParams): string {
  const url = new URL(CLAUDE_AUTHORIZE_URL);
  const query: Record<string, string> = {
    code: 'true',
    client_id: CLAUDE_OAUTH_CLIENT_ID,
    response_type: 'code',
    redirect_uri: params.redirectUri,
    scope: CLAUDE_OAUTH_SCOPE,
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
    state: params.state,
  };
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.href;
}

/** Accepts `CODE#STATE` (as the console page shows it) or a bare code. Undefined when unusable. */
export function parseClaudePastedCode(pasted: string, expectedState: string): string | undefined {
  if (typeof pasted !== 'string') return undefined;
  const [code, state = expectedState] = pasted.trim().split('#');
  if (!code || code.length > 4096 || /\s/.test(code) || state !== expectedState) return undefined;
  return code;
}

export type ClaudeTokenRequest =
  | { kind: 'authorization_code'; code: string; state: string; verifier: string; redirectUri: string }
  | { kind: 'refresh_token'; refreshToken: string };

export type ClaudeTokenRequestBody =
  | { grant_type: 'authorization_code'; code: string; state: string; client_id: string; redirect_uri: string; code_verifier: string }
  | { grant_type: 'refresh_token'; refresh_token: string; client_id: string };

/** Exactly the JSON body the Claude token endpoint takes. */
export function buildClaudeTokenRequest(request: ClaudeTokenRequest): ClaudeTokenRequestBody {
  if (request.kind === 'authorization_code') {
    return {
      grant_type: 'authorization_code',
      code: request.code,
      state: request.state,
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      redirect_uri: request.redirectUri,
      code_verifier: request.verifier,
    };
  }
  return { grant_type: 'refresh_token', refresh_token: request.refreshToken, client_id: CLAUDE_OAUTH_CLIENT_ID };
}

const EXCHANGE_KEYS = ['client_id', 'code', 'code_verifier', 'grant_type', 'redirect_uri', 'state'];
const REFRESH_KEYS = ['client_id', 'grant_type', 'refresh_token'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function grantText(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 4096 && !/[\s\u0000-\u001f\u007f]/.test(value);
}

function base64urlText(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 43 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

/**
 * Strict allowlist for what a token relay may forward. Returns the re-built body, or undefined when
 * the value is anything but one of the two exact grant shapes with this client's id and redirect.
 */
export function validateClaudeTokenRequest(value: unknown): ClaudeTokenRequestBody | undefined {
  if (!isPlainObject(value)) return undefined;
  const keys = Object.keys(value).sort();
  const same = (expected: string[]) => keys.length === expected.length && keys.every((key, index) => key === expected[index]);
  if (value.client_id !== CLAUDE_OAUTH_CLIENT_ID) return undefined;
  if (value.grant_type === 'authorization_code' && same(EXCHANGE_KEYS)) {
    if (value.redirect_uri !== CLAUDE_PASTE_REDIRECT_URI) return undefined;
    if (!grantText(value.code) || !base64urlText(value.state) || !base64urlText(value.code_verifier)) return undefined;
    return buildClaudeTokenRequest({
      kind: 'authorization_code', code: value.code, state: value.state, verifier: value.code_verifier, redirectUri: CLAUDE_PASTE_REDIRECT_URI,
    });
  }
  if (value.grant_type === 'refresh_token' && same(REFRESH_KEYS)) {
    if (!grantText(value.refresh_token)) return undefined;
    return buildClaudeTokenRequest({ kind: 'refresh_token', refreshToken: value.refresh_token });
  }
  return undefined;
}

export type ClaudeTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  account?: { email_address: string };
};

function shortText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Keeps only the fields a client needs from a token response; undefined without a usable access token. */
export function filterClaudeTokenResponse(payload: unknown): ClaudeTokenResponse | undefined {
  if (!isPlainObject(payload) || !shortText(payload.access_token, 32_768)) return undefined;
  const email = isPlainObject(payload.account) && shortText(payload.account.email_address, 256) ? payload.account.email_address : undefined;
  return {
    access_token: payload.access_token,
    ...(shortText(payload.refresh_token, 32_768) ? { refresh_token: payload.refresh_token } : {}),
    ...(typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in) && payload.expires_in > 0 ? { expires_in: payload.expires_in } : {}),
    ...(shortText(payload.token_type, 64) ? { token_type: payload.token_type } : {}),
    ...(shortText(payload.scope, 512) ? { scope: payload.scope } : {}),
    ...(email ? { account: { email_address: email } } : {}),
  };
}
