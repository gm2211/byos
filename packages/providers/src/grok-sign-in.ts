/**
 * Grok (xAI) subscription credentials for a browser or native app: the encoded credential record,
 * the refresh grant against auth.x.ai, and the vault binding. The device-code sign-in itself runs
 * through the site's device-code broker (`createDeviceCodeBroker` in @byos/server) or
 * `@byos/grok-local`; this module keeps what they return usable past the first hour.
 *
 * TOKEN RULE: a refresh grant never passes through a plaintext host relay. In a browser the
 * `tokenFetch` is `createCodexTlsFetch` from @byos/browser-tls (the codex relay must enable the
 * ciphertext `xai-auth` destination), which runs TLS inside the page; Node and native pass
 * `globalThis.fetch`. Inference goes browser -> api.x.ai with the access token only. Live xAI
 * behavior is unverified; tests are synthetic.
 */
import {
  createCredentialRefresher,
  parseXaiTokenResponse,
  XAI_DEFAULT_LIFETIME_SECONDS,
  XAI_FORM_HEADERS,
  XAI_REFRESH_WINDOW_MS,
  XAI_TOKEN_URL,
  classifyXaiRefreshFailure,
  xaiFormBody,
  type SubscriptionRefresh,
} from '@byos/core';

/** Always called with `XAI_TOKEN_URL`. Browser: `createCodexTlsFetch` (relay enables `xai-auth`). Node: `globalThis.fetch`. */
export type GrokTokenFetch = (input: string, init: RequestInit) => Promise<Response>;

const CREDENTIAL_PREFIX = 'grok-subscription:';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export type GrokCredential = { accessToken: string; refreshToken?: string; idToken?: string; expiresAt: number; label?: string };

/** Fixed text only; never anything the provider said. */
export class GrokAuthError extends Error {
  readonly status: number;
  constructor(status = 502, message = 'Grok sign-in could not be refreshed. Try again in a moment.') {
    super(message);
    this.status = status;
    this.name = 'GrokAuthError';
  }
}

export class GrokReconnectRequiredError extends Error {
  readonly status = 401;
  constructor(message = 'Your Grok sign-in expired. Connect it again.') {
    super(message);
    this.name = 'GrokReconnectRequiredError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validText(value: unknown, maxLength = 32_768): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !/[\s\u0000-\u001f\u007f]/.test(value);
}

function textToBase64url(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToText(value: string): string {
  const encoded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(encoded + '='.repeat((4 - encoded.length % 4) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
}

function linkedSignal(parent?: AbortSignal): AbortSignal {
  return AbortSignal.any([...(parent ? [parent] : []), AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
}

/** One opaque string for the site's vault. Field order is fixed so equal credentials encode equally. */
export function encodeGrokCredential(credential: GrokCredential): string {
  const normalized: GrokCredential = {
    accessToken: credential.accessToken,
    ...(credential.refreshToken ? { refreshToken: credential.refreshToken } : {}),
    ...(credential.idToken ? { idToken: credential.idToken } : {}),
    expiresAt: credential.expiresAt,
    ...(credential.label ? { label: credential.label } : {}),
  };
  return `${CREDENTIAL_PREFIX}${textToBase64url(JSON.stringify(normalized))}`;
}

/** Accepts only the prefixed form; a bare token (an API key) is not a Grok subscription record. */
export function decodeGrokCredential(value: string | undefined | null): GrokCredential | undefined {
  if (!value || !value.startsWith(CREDENTIAL_PREFIX)) return undefined;
  try {
    const payload: unknown = JSON.parse(base64urlToText(value.slice(CREDENTIAL_PREFIX.length)));
    if (!isRecord(payload) || !validText(payload.accessToken)) return undefined;
    if (typeof payload.expiresAt !== 'number' || !Number.isFinite(payload.expiresAt)) return undefined;
    return {
      accessToken: payload.accessToken,
      ...(validText(payload.refreshToken) ? { refreshToken: payload.refreshToken } : {}),
      ...(validText(payload.idToken) ? { idToken: payload.idToken } : {}),
      expiresAt: payload.expiresAt,
      ...(typeof payload.label === 'string' && payload.label.length > 0 && payload.label.length <= 320 ? { label: payload.label } : {}),
    };
  } catch { return undefined; }
}

export function isGrokSubscriptionRecord(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.startsWith(CREDENTIAL_PREFIX);
}

export function grokNeedsRefresh(credential: GrokCredential, now = Date.now()): boolean {
  // Not tokenNeedsRefresh: an unknown expiry (0, from a legacy pair) must refresh on first use.
  return credential.expiresAt - now <= XAI_REFRESH_WINDOW_MS;
}

/** What the device-code broker (or grok-local) returns: the encoded credential to store as the Grok token. */
export function grokCredentialFromDeviceTokens(
  tokens: { accessToken: string; refreshToken?: string; idToken?: string; expiresIn?: number },
  now = Date.now(),
): string {
  const lifetime = typeof tokens.expiresIn === 'number' && Number.isFinite(tokens.expiresIn) && tokens.expiresIn > 0
    ? Math.min(tokens.expiresIn, 365 * 24 * 3600) : XAI_DEFAULT_LIFETIME_SECONDS;
  return encodeGrokCredential({
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.idToken ? { idToken: tokens.idToken } : {}),
    expiresAt: now + lifetime * 1000,
  });
}

/**
 * Upgrades a sign-in an app stored as a bare access token plus a separate refresh record. An
 * unknown expiry is 0, so the first use refreshes. With no refresh grant the bare token is returned
 * unchanged (an API key or a token that can only expire).
 */
export function grokCredentialFromLegacy(accessToken: string, refresh: { refreshToken: string; expiresAt?: number } | null): string {
  if (!refresh?.refreshToken) return accessToken;
  return encodeGrokCredential({ accessToken, refreshToken: refresh.refreshToken, expiresAt: refresh.expiresAt ?? 0 });
}

/** The vault surface `grokVaultBinding` needs (`createCredentialVault` from @byos/core satisfies it). */
export type GrokVault<P extends string = string> = {
  read(slot: P): string;
  readRefresh(slot: P): SubscriptionRefresh | null;
  persistence(slot: P): 'session' | 'browser';
  store(slot: P, value: string, where: 'session' | 'browser'): void;
  storeRefresh(slot: P, record: SubscriptionRefresh | null, where: 'session' | 'browser'): void;
};

/**
 * `readCredential`/`saveCredential` over a vault that keeps the access token and the refresh grant
 * in separate slots (Motive's layout). A legacy pair reads as an encoded record; saving splits it
 * again. Deterministic, so the refresh lock's string comparison holds across read, save, read.
 */
export function grokVaultBinding<P extends string>(vault: GrokVault<P>, slot: P): {
  readCredential: () => string;
  saveCredential: (value: string) => void;
} {
  return {
    readCredential() {
      const token = vault.read(slot);
      if (!token || isGrokSubscriptionRecord(token)) return token;
      const refresh = vault.readRefresh(slot);
      return refresh ? grokCredentialFromLegacy(token, refresh) : token;
    },
    saveCredential(value) {
      const where = vault.persistence(slot);
      const credential = decodeGrokCredential(value);
      if (!credential) { vault.store(slot, value, where); return; }
      vault.store(slot, credential.accessToken, where);
      vault.storeRefresh(slot, credential.refreshToken ? { refreshToken: credential.refreshToken, expiresAt: credential.expiresAt } : null, where);
    },
  };
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new GrokAuthError(response.status);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => undefined); throw new GrokAuthError(response.status); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new GrokAuthError(response.status); }
}

/** Trades the refresh grant for a new credential (the grant may rotate; the old one is kept if none returns). */
export async function refreshGrokCredential(tokenFetch: GrokTokenFetch, current: GrokCredential, signal?: AbortSignal, now = Date.now()): Promise<string> {
  if (!validText(current.refreshToken, 4096)) throw new GrokReconnectRequiredError();
  let response: Response;
  try {
    response = await tokenFetch(XAI_TOKEN_URL, {
      method: 'POST',
      headers: { ...XAI_FORM_HEADERS },
      body: xaiFormBody({ kind: 'refresh_token', refreshToken: current.refreshToken }),
      redirect: 'error',
      credentials: 'omit',
      signal: linkedSignal(signal),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new GrokAuthError();
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (classifyXaiRefreshFailure(response.status) === 'reconnect') throw new GrokReconnectRequiredError();
    throw new GrokAuthError();
  }
  const tokens = parseXaiTokenResponse(await readJson(response), { previousRefreshToken: current.refreshToken, now });
  if (!tokens) throw new GrokAuthError();
  return encodeGrokCredential({ ...tokens, ...(current.label ? { label: current.label } : {}) });
}

export type GrokSubscriptionOptions = {
  /** `createCodexTlsFetch(...)` in a browser (relay destination `xai-auth`), `globalThis.fetch` in Node. */
  tokenFetch: GrokTokenFetch;
  /** The credential as the vault holds it now (another tab may have refreshed it). */
  readCredential: () => string | null | undefined;
  /** Saves a refreshed credential in the same place. */
  saveCredential: (value: string) => void;
  /** Site-specific suffix for the cross-tab Web Lock. */
  namespace?: string;
};

export type GrokSubscription = {
  /** The string to send as the API key: an encoded record becomes its (refreshed) access token. */
  accessToken(token: string, options?: { force?: boolean; signal?: AbortSignal }): Promise<string>;
};

export function createGrokSubscription(options: GrokSubscriptionOptions): GrokSubscription {
  const refresher = createCredentialRefresher({
    lockName: `byos-grok-refresh:${options.namespace?.trim() || 'default'}`,
    readCredential: () => options.readCredential(),
    saveCredential: value => options.saveCredential(value),
    reconnectError: () => new GrokReconnectRequiredError(),
  });
  return {
    async accessToken(token, { force = false, signal } = {}) {
      if (!isGrokSubscriptionRecord(token)) return token;
      const current = decodeGrokCredential(token);
      if (!current) throw new GrokReconnectRequiredError();
      if (!force && !grokNeedsRefresh(current)) return current.accessToken;
      const expired = current.expiresAt <= Date.now();
      if (!current.refreshToken) {
        if (force || expired) throw new GrokReconnectRequiredError();
        return current.accessToken;
      }
      try {
        const value = await refresher.refreshed(token, () => refreshGrokCredential(options.tokenFetch, current, signal), signal);
        const next = decodeGrokCredential(value);
        if (!next) throw new GrokReconnectRequiredError();
        return next.accessToken;
      } catch (error) {
        // A transient failure must not sign the user out while the token still works.
        if (error instanceof GrokAuthError && !force && !expired) return current.accessToken;
        throw error;
      }
    },
  };
}
