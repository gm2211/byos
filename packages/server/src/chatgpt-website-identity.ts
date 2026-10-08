/**
 * Identity-only Sign in with ChatGPT for approved website clients.
 *
 * This deliberately discards all OAuth tokens after validating the ID token. It is not a ChatGPT
 * plan-usage grant and does not provide model access. Consumers bind the transaction store to a
 * server-generated browser session and create their own first-party session from the returned
 * verified identity.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';

const ISSUER = 'https://auth.openai.com';
const AUTHORIZATION_ENDPOINT = `${ISSUER}/api/accounts/authorize`;
const TOKEN_ENDPOINT = `${ISSUER}/api/accounts/oauth/token`;
const DISCOVERY_ENDPOINT = `${ISSUER}/.well-known/openid-configuration`;
const JWKS_ENDPOINT = `${ISSUER}/.well-known/jwks.json`;
const SCOPE = 'openid profile email';
const TRANSACTION_LIFETIME_MS = 10 * 60 * 1000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_CODE_LENGTH = 4096;
const REQUEST_TIMEOUT_MS = 10_000;
const SAFE_ERROR = 'Sign in with ChatGPT could not be completed. Start again.';

export type ChatGptWebsiteIdentityErrorCode = 'not_configured' | 'invalid_request' | 'sign_in_failed';

const ERROR_MESSAGES: Record<ChatGptWebsiteIdentityErrorCode, string> = {
  not_configured: 'Sign in with ChatGPT is not configured for this website.',
  invalid_request: 'The sign-in request could not be started.',
  sign_in_failed: SAFE_ERROR,
};

export class ChatGptWebsiteIdentityError extends Error {
  readonly code: ChatGptWebsiteIdentityErrorCode;
  constructor(code: ChatGptWebsiteIdentityErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ChatGptWebsiteIdentityError';
    this.code = code;
  }
}

export interface ChatGptWebsiteTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: number;
}

/**
 * `consume` must atomically read-and-delete the transaction for a browser binding across all
 * instances. Implementations should retain no transaction past `expiresAt` and must not log values.
 */
export interface ChatGptWebsiteTransactionStore {
  put(browserBinding: string, transaction: ChatGptWebsiteTransaction): Promise<void>;
  consume(browserBinding: string): Promise<ChatGptWebsiteTransaction | undefined>;
}

export interface ChatGptWebsiteIdentity {
  issuer: typeof ISSUER;
  clientId: string;
  subject: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  picture?: string;
}

export interface ChatGptWebsiteIdentityOptions {
  /** OpenAI-provisioned website client ID. No illustrative or fallback ID is accepted. */
  clientId?: string;
  /** Exact callback URL registered with OpenAI for this environment. */
  redirectUri?: string;
  transactions: ChatGptWebsiteTransactionStore;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface ChatGptWebsiteIdentityClient {
  enabled: boolean;
  begin(browserBinding: string): Promise<{ authorizationUrl: string }>;
  complete(browserBinding: string, callbackUrl: string | URL, signal?: AbortSignal): Promise<ChatGptWebsiteIdentity>;
}

function randomValue(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function validBinding(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 32 && value.length <= 512
    && /^[A-Za-z0-9._~-]+$/.test(value);
}

function safeClientId(value: unknown): value is string {
  return typeof value === 'string' && /^oaiapp_[A-Za-z0-9_-]{1,200}$/.test(value);
}

function exactHttpsUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048 || value !== value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash
      && url.search === '' && url.origin !== 'https://auth.openai.com' && url.href === value;
  } catch { return false; }
}

function callbackMatches(callback: URL, redirectUri: string): boolean {
  const registered = new URL(redirectUri);
  const callbackBase = new URL(callback);
  callbackBase.search = '';
  callbackBase.hash = '';
  return callbackBase.href === registered.href && callback.username === '' && callback.password === '' && callback.hash === '';
}

async function readBoundedJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new ChatGptWebsiteIdentityError('sign_in_failed');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ChatGptWebsiteIdentityError('sign_in_failed');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ChatGptWebsiteIdentityError('sign_in_failed'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ChatGptWebsiteIdentityError('sign_in_failed');
  return payload as Record<string, unknown>;
}

function cleanClaim(value: unknown, max = 2048): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}

function safeAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ChatGptWebsiteIdentityError('sign_in_failed');
}

function boundedSignal(signal?: AbortSignal): AbortSignal {
  return AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
}

/**
 * Create an identity-only OpenID Connect client. Configuration is disabled until OpenAI has
 * provisioned the client ID and exact callback URL. Only public-client token auth (`none`) is used.
 */
export function createChatGptWebsiteIdentity(options: ChatGptWebsiteIdentityOptions): ChatGptWebsiteIdentityClient {
  const now = options.now ?? Date.now;
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const configured = options.clientId !== undefined || options.redirectUri !== undefined;
  if (configured && (!safeClientId(options.clientId) || !exactHttpsUri(options.redirectUri))) {
    throw new TypeError('Sign in with ChatGPT requires an OpenAI-provisioned client ID and exact HTTPS callback URL.');
  }
  const enabled = safeClientId(options.clientId) && exactHttpsUri(options.redirectUri);
  const clientId = enabled ? options.clientId : undefined;
  const redirectUri = enabled ? options.redirectUri : undefined;
  let discoveryPromise: Promise<void> | undefined;

  async function ensureDiscovery(signal?: AbortSignal): Promise<void> {
    if (!discoveryPromise) {
      discoveryPromise = (async () => {
        safeAbort(signal);
        let response: Response;
        try { response = await doFetch(DISCOVERY_ENDPOINT, { method: 'GET', redirect: 'error', signal: boundedSignal(signal), headers: { accept: 'application/json' } }); }
        catch { throw new ChatGptWebsiteIdentityError('sign_in_failed'); }
        if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new ChatGptWebsiteIdentityError('sign_in_failed'); }
        const metadata = await readBoundedJson(response);
        if (metadata.issuer !== ISSUER || metadata.authorization_endpoint !== AUTHORIZATION_ENDPOINT
          || metadata.token_endpoint !== TOKEN_ENDPOINT || metadata.jwks_uri !== JWKS_ENDPOINT
          || !Array.isArray(metadata.id_token_signing_alg_values_supported)
          || !metadata.id_token_signing_alg_values_supported.includes('RS256')) throw new ChatGptWebsiteIdentityError('sign_in_failed');
      })();
      discoveryPromise.catch(() => { discoveryPromise = undefined; });
    }
    return discoveryPromise;
  }

  function requireEnabled(): void {
    if (!enabled) throw new ChatGptWebsiteIdentityError('not_configured');
  }

  async function fixedPost(url: string, body: URLSearchParams, signal?: AbortSignal): Promise<Response> {
    safeAbort(signal);
    try {
      return await doFetch(url, {
        method: 'POST', redirect: 'error', signal: boundedSignal(signal),
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch {
      throw new ChatGptWebsiteIdentityError('sign_in_failed');
    }
  }

  async function getJwks(signal?: AbortSignal): Promise<ReturnType<typeof createLocalJWKSet>> {
    safeAbort(signal);
    let response: Response;
    try { response = await doFetch(JWKS_ENDPOINT, { method: 'GET', redirect: 'error', signal: boundedSignal(signal), headers: { accept: 'application/json' } }); }
    catch { throw new ChatGptWebsiteIdentityError('sign_in_failed'); }
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new ChatGptWebsiteIdentityError('sign_in_failed'); }
    const body = await readBoundedJson(response);
    if (!Array.isArray(body.keys) || body.keys.length === 0 || body.keys.length > 64) throw new ChatGptWebsiteIdentityError('sign_in_failed');
    return createLocalJWKSet(body as unknown as JSONWebKeySet);
  }

  return {
    enabled,
    async begin(browserBinding) {
      requireEnabled();
      if (!validBinding(browserBinding)) throw new ChatGptWebsiteIdentityError('invalid_request');
      const state = randomValue();
      const nonce = randomValue();
      const codeVerifier = randomValue(48);
      const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
      await ensureDiscovery();
      try { await options.transactions.put(browserBinding, { state, nonce, codeVerifier, expiresAt: now() + TRANSACTION_LIFETIME_MS }); }
      catch { throw new ChatGptWebsiteIdentityError('sign_in_failed'); }
      const url = new URL(AUTHORIZATION_ENDPOINT);
      url.search = new URLSearchParams({
        client_id: clientId!, redirect_uri: redirectUri!, response_type: 'code', scope: SCOPE,
        state, nonce, code_challenge: codeChallenge, code_challenge_method: 'S256',
      }).toString();
      return { authorizationUrl: url.toString() };
    },
    async complete(browserBinding, callbackUrl, signal) {
      requireEnabled();
      if (!validBinding(browserBinding)) throw new ChatGptWebsiteIdentityError('sign_in_failed');
      let callback: URL;
      try { callback = new URL(callbackUrl); } catch { throw new ChatGptWebsiteIdentityError('sign_in_failed'); }
      if (!callbackMatches(callback, redirectUri!)) throw new ChatGptWebsiteIdentityError('sign_in_failed');

      // Consume before parsing or exchanging: every callback attempt is single use, including failures.
      let transaction: ChatGptWebsiteTransaction | undefined;
      try { transaction = await options.transactions.consume(browserBinding); }
      catch { throw new ChatGptWebsiteIdentityError('sign_in_failed'); }
      if (!transaction || !Number.isSafeInteger(transaction.expiresAt) || transaction.expiresAt <= now()
        || !/^[A-Za-z0-9_-]{43}$/.test(transaction.state)
        || !/^[A-Za-z0-9_-]{43}$/.test(transaction.nonce)
        || !/^[A-Za-z0-9_-]{64}$/.test(transaction.codeVerifier)
        || callback.searchParams.getAll('state').length !== 1
        || callback.searchParams.get('state') !== transaction.state) throw new ChatGptWebsiteIdentityError('sign_in_failed');
      if (callback.searchParams.has('error') || callback.searchParams.getAll('code').length !== 1) throw new ChatGptWebsiteIdentityError('sign_in_failed');
      const code = callback.searchParams.get('code');
      if (!code || code.length > MAX_CODE_LENGTH || /[\u0000-\u0020\u007f]/.test(code)) throw new ChatGptWebsiteIdentityError('sign_in_failed');

      await ensureDiscovery(signal);
      const tokenResponse = await fixedPost(TOKEN_ENDPOINT, new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: redirectUri!, client_id: clientId!,
        code_verifier: transaction.codeVerifier,
      }), signal);
      if (!tokenResponse.ok) { await tokenResponse.body?.cancel().catch(() => undefined); throw new ChatGptWebsiteIdentityError('sign_in_failed'); }
      const tokenPayload = await readBoundedJson(tokenResponse);
      const idToken = cleanClaim(tokenPayload.id_token, 32_768);
      if (!idToken) throw new ChatGptWebsiteIdentityError('sign_in_failed');
      // Drop the entire token payload immediately; no access/refresh tokens cross this API boundary.
      for (const key of Object.keys(tokenPayload)) delete tokenPayload[key];

      const jwks = await getJwks(signal);
      let payload: Record<string, unknown>;
      try {
        const verified = await jwtVerify(idToken, jwks, {
          issuer: ISSUER, audience: clientId!, requiredClaims: ['sub', 'exp', 'iat'], algorithms: ['RS256'],
          clockTolerance: 5, maxTokenAge: 600, currentDate: new Date(now()),
        });
        payload = verified.payload as Record<string, unknown>;
      } catch { throw new ChatGptWebsiteIdentityError('sign_in_failed'); }
      const audience = payload.aud;
      const multipleAudiences = Array.isArray(audience) && audience.length > 1;
      if (payload.nonce !== transaction.nonce || typeof payload.sub !== 'string' || !payload.sub
        || payload.sub.length > 512 || /[\u0000-\u001f\u007f]/.test(payload.sub)
        || typeof payload.iat !== 'number' || !Number.isFinite(payload.iat) || payload.iat > Math.floor(now() / 1000) + 5
        || (payload.azp !== undefined && payload.azp !== clientId) || (multipleAudiences && payload.azp !== clientId)) throw new ChatGptWebsiteIdentityError('sign_in_failed');
      return {
        issuer: ISSUER, clientId: clientId!, subject: payload.sub,
        ...(cleanClaim(payload.email, 320) ? { email: cleanClaim(payload.email, 320) } : {}),
        ...(typeof payload.email_verified === 'boolean' ? { emailVerified: payload.email_verified } : {}),
        ...(cleanClaim(payload.name) ? { name: cleanClaim(payload.name) } : {}),
        ...(cleanClaim(payload.picture) ? { picture: cleanClaim(payload.picture) } : {}),
      };
    },
  };
}
