/** Node-only Grok (xAI SuperGrok) subscription client: device-code sign-in, Keychain tokens, direct HTTPS refresh. */
import { classifyXaiRefreshFailure, parseXaiTokenResponse, XAI_REFRESH_WINDOW_MS } from '@byos/core';
import { GrokError, checkSignal } from './errors.js';
import { keychainStore, processLock, type CredentialStore } from './storage.js';
import { defaultSleep, deviceSignIn, postForm, type DeviceCodeInfo, type GrokFetch, type Sleep } from './device.js';
export { GrokError, type GrokErrorCode } from './errors.js';
export type { CredentialStore } from './storage.js';
export type { DeviceCodeInfo } from './device.js';
export {
  XAI_OAUTH_CLIENT_ID, XAI_DEVICE_CODE_URL, XAI_TOKEN_URL, XAI_OAUTH_SCOPE, XAI_DEVICE_CODE_GRANT, XAI_REFRESH_WINDOW_MS,
} from '@byos/core';

export type GrokAccount = { label: string };
export type GrokStatus = { connected: boolean; account?: GrokAccount };
export type GrokClientOptions = {
  appName: string; namespace: string;
  /** Private directory for nonsecret inter-process lock files only. */
  storageDirectory?: string;
  credentialStore?: CredentialStore; fetch?: GrokFetch; now?: () => number; sleep?: Sleep;
};
export interface GrokClient {
  status(): Promise<GrokStatus>;
  /** Device-code sign-in: `onCode` gets the verification URL and user code to show; resolves once approved. */
  signIn(options: { onCode: (info: DeviceCodeInfo) => void | Promise<void>; signal?: AbortSignal }): Promise<GrokStatus>;
  disconnect(): Promise<void>;
  /**
   * A usable access token, refreshed when it expires within 5 minutes. With `rejected` (the token the API
   * just refused with 401) it refreshes now unless another process already rotated it. A refresh answered with
   * 400 or 401 deletes the stored tokens and fails with `reconnect-required`; any other refresh failure keeps
   * the current token while it is still valid.
   */
  accessToken(signal?: AbortSignal, options?: { rejected?: string }): Promise<string>;
  /** Runs `fn` with an access token; when it throws an error with `status` 401, refreshes once and retries once. */
  run<T>(signal: AbortSignal | undefined, fn: (accessToken: string) => Promise<T>): Promise<T>;
  /** Adopts tokens an app already holds (for example from an older Keychain item). Replaces any stored sign-in. */
  importTokens(tokens: { access: string; refresh?: string; expiresAt: number; label?: string }, signal?: AbortSignal): Promise<GrokStatus>;
}
type Tokens = { access: string; refresh?: string; idToken?: string; expiresAt: number; label?: string };
type State = { version: 1; tokens?: Tokens };

const str = (x: unknown, max = 32_768): x is string => typeof x === 'string' && x.length > 0 && x.length <= max && !/[\u0000-\u001f\u007f]/.test(x);
const rec = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

function parseState(raw: string | null): State {
  if (raw === null) return { version: 1 };
  try {
    const s: unknown = JSON.parse(raw);
    if (!rec(s) || s.version !== 1) throw new Error();
    const t = s.tokens;
    if (t !== undefined && (!rec(t) || !str(t.access) || (t.refresh !== undefined && !str(t.refresh)) || (t.idToken !== undefined && !str(t.idToken))
      || typeof t.expiresAt !== 'number' || !Number.isFinite(t.expiresAt) || (t.label !== undefined && !str(t.label, 320)))) throw new Error();
    return s as State;
  } catch { throw new GrokError('storage-unavailable'); }
}

/** The `email` claim of an id_token, unverified (display only). */
function emailFromIdToken(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return rec(claims) && str(claims.email, 256) ? claims.email : undefined;
  } catch { return undefined; }
}

export function createGrokClient(options: GrokClientOptions): GrokClient {
  if (!str(options.appName, 100) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(options.namespace)) throw new TypeError('A valid appName and namespace are required.');
  const store = options.credentialStore ?? keychainStore(options.namespace);
  const locked = processLock(options.namespace, options.storageDirectory);
  const fetcher = options.fetch ?? globalThis.fetch, now = options.now ?? Date.now, sleep = options.sleep ?? defaultSleep;
  let signingIn = false;
  const load = async () => { try { return parseState(await store.read()); } catch { throw new GrokError('storage-unavailable'); } };
  const save = async (s: State) => { try { await store.write(JSON.stringify(s)); } catch { throw new GrokError('storage-unavailable'); } };
  const statusOf = (s: State): GrokStatus => s.tokens ? { connected: true, account: { label: s.tokens.label ?? emailFromIdToken(s.tokens.idToken) ?? 'Grok subscription' } } : { connected: false };
  const guarded = async <T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    try { return await run(); } catch (e) { checkSignal(signal); if (e instanceof GrokError) throw e; throw new GrokError('unavailable'); }
  };

  async function accessToken(signal?: AbortSignal, rejected?: string): Promise<string> {
    return guarded(() => locked(async () => {
      const s = await load(), t = s.tokens;
      if (!t) throw new GrokError('reconnect-required');
      const fresh = t.expiresAt > now() + XAI_REFRESH_WINDOW_MS;
      // Another process may already have rotated the rejected token while this one waited for the lock.
      if (rejected === undefined ? fresh : t.access !== rejected && t.expiresAt > now() + 60_000) return t.access;
      if (!t.refresh) {
        if (rejected !== undefined || t.expiresAt <= now()) { delete s.tokens; await save(s); throw new GrokError('reconnect-required'); }
        return t.access;
      }
      let result: Awaited<ReturnType<typeof postForm>>;
      try { result = await postForm(fetcher, { kind: 'refresh_token', refreshToken: t.refresh }); }
      catch (e) {
        if (rejected === undefined && t.expiresAt > now()) return t.access;
        throw e;
      }
      if (!result.ok) {
        if (classifyXaiRefreshFailure(result.status) === 'reconnect') { delete s.tokens; await save(s); throw new GrokError('reconnect-required', result.status); }
        if (rejected === undefined && t.expiresAt > now()) return t.access;
        throw new GrokError('unavailable', result.status);
      }
      const next = parseXaiTokenResponse(result.body, { previousRefreshToken: t.refresh, now: now() });
      if (!next) {
        if (rejected === undefined && t.expiresAt > now()) return t.access;
        throw new GrokError('invalid-response');
      }
      // The grant may rotate: persist the replacement even if this caller cancels meanwhile.
      s.tokens = { access: next.accessToken, ...(next.refreshToken ? { refresh: next.refreshToken } : {}), ...(next.idToken ?? t.idToken ? { idToken: next.idToken ?? t.idToken } : {}), expiresAt: next.expiresAt, ...(t.label ? { label: t.label } : {}) };
      await save(s); checkSignal(signal);
      return next.accessToken;
    }, signal), signal);
  }

  return {
    status: () => guarded(() => locked(async () => statusOf(await load()))),
    async signIn(input) {
      if (typeof input?.onCode !== 'function') throw new TypeError('onCode is required.');
      if (signingIn) throw new GrokError('busy'); signingIn = true;
      try {
        return await guarded(async () => {
          const tokens = await deviceSignIn({ fetch: fetcher, onCode: input.onCode, signal: input.signal, now, sleep });
          const stored: Tokens = { access: tokens.accessToken, ...(tokens.refreshToken ? { refresh: tokens.refreshToken } : {}), ...(tokens.idToken ? { idToken: tokens.idToken } : {}), expiresAt: tokens.expiresAt };
          return locked(async () => { const s: State = { version: 1, tokens: stored }; await save(s); return statusOf(s); }, input.signal);
        }, input.signal);
      } finally { signingIn = false; }
    },
    disconnect: () => guarded(() => locked(async () => { await save({ version: 1 }); })),
    accessToken: (signal, o) => accessToken(signal, o?.rejected),
    async run(signal, fn) {
      const access = await accessToken(signal);
      try { return await fn(access); }
      catch (e) {
        if (!(rec(e) || e instanceof Error) || (e as { status?: unknown }).status !== 401) throw e;
        return fn(await accessToken(signal, access));
      }
    },
    importTokens: (tokens, signal) => guarded(async () => {
      if (!str(tokens?.access) || (tokens.refresh !== undefined && !str(tokens.refresh)) || typeof tokens.expiresAt !== 'number' || !Number.isFinite(tokens.expiresAt) || (tokens.label !== undefined && !str(tokens.label, 320))) throw new GrokError('invalid-response');
      return locked(async () => {
        const s: State = { version: 1, tokens: { access: tokens.access, ...(tokens.refresh ? { refresh: tokens.refresh } : {}), expiresAt: tokens.expiresAt, ...(tokens.label ? { label: tokens.label } : {}) } };
        await save(s); return statusOf(s);
      }, signal);
    }, signal),
  };
}
