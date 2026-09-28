import { resolveStorage, safeGet, safeRemove, type ByosStorage } from './storage.js';

/**
 * TOKEN RULE: a provider token may cross the site's backend once, only to complete the sign-in
 * handshake (disclosed to the user). After that it lives only here, in the browser, and every model
 * call goes browser to provider. Nothing in this vault sends a token anywhere; never add a method
 * that does.
 */

/** `session`: this tab only. `browser`: remembered on this browser until signed out. */
export type CredentialPersistence = 'session' | 'browser';

/** The rotation half of a subscription connection. Absent for a plain API key. */
export type SubscriptionRefresh = { refreshToken: string; expiresAt?: number };

export type CredentialVault<P extends string = string> = ReturnType<typeof createCredentialVault<P>>;

export type CredentialVaultOptions = {
  /** Storage key prefix, e.g. `motive-ai-credential:`. One per site, so sites sharing an origin
   * never read each other's tokens. */
  prefix: string;
  storage?: ByosStorage;
};

function restore(storage: Storage, key: string, value: string | null): void {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch { /* Best-effort rollback; source values stay untouched until the destination verifies. */ }
}

export function createCredentialVault<P extends string = string>(options: CredentialVaultOptions) {
  const tokenKey = (provider: P) => `${options.prefix}${provider}`;
  // A sibling key, not a JSON blob in the token slot, so every reader of "the credential" stays a
  // plain string.
  const refreshKey = (provider: P) => `${tokenKey(provider)}:refresh`;
  const areas = () => resolveStorage(options.storage);

  function required(): { session: Storage; local: Storage } {
    const { session, local } = areas();
    if (!session || !local) throw new Error('Browser storage is unavailable, so this sign-in cannot be kept.');
    return { session, local };
  }

  function read(provider: P): string {
    const { session, local } = areas();
    return safeGet(session, tokenKey(provider)) ?? safeGet(local, tokenKey(provider)) ?? '';
  }

  function persistence(provider: P): CredentialPersistence {
    return safeGet(areas().local, tokenKey(provider)) ? 'browser' : 'session';
  }

  function store(provider: P, value: string, where: CredentialPersistence): void {
    const token = value.trim();
    const { session, local } = required();
    session.removeItem(tokenKey(provider));
    local.removeItem(tokenKey(provider));
    if (!token) return;
    (where === 'browser' ? local : session).setItem(tokenKey(provider), token);
  }

  function readRefresh(provider: P): SubscriptionRefresh | null {
    const { session, local } = areas();
    const raw = safeGet(session, refreshKey(provider)) ?? safeGet(local, refreshKey(provider));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<SubscriptionRefresh>;
      if (!parsed?.refreshToken) return null;
      return { refreshToken: parsed.refreshToken, expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : undefined };
    } catch {
      // Malformed reads as "no refresh grant", which degrades to reconnecting.
      return null;
    }
  }

  /** Stores (or, with null, clears) the refresh record in the same area as the access token, so the
   * two never outlive one another. */
  function storeRefresh(provider: P, record: SubscriptionRefresh | null, where: CredentialPersistence): void {
    const { session, local } = required();
    session.removeItem(refreshKey(provider));
    local.removeItem(refreshKey(provider));
    if (!record?.refreshToken) return;
    (where === 'browser' ? local : session).setItem(refreshKey(provider), JSON.stringify(record));
  }

  function clearRefresh(provider: P): void {
    const { session, local } = areas();
    safeRemove(session, refreshKey(provider));
    safeRemove(local, refreshKey(provider));
  }

  /** Forgets the token and its refresh grant together, so a later refresh cannot silently revive a
   * connection the user removed. */
  function clear(provider: P): void {
    const { session, local } = areas();
    safeRemove(session, tokenKey(provider));
    safeRemove(local, tokenKey(provider));
    clearRefresh(provider);
  }

  /** Moves a token and its refresh grant together between tab-only and remembered storage. The
   * destination is verified before the source is cleared, so a quota or security error cannot erase
   * the working sign-in; partial destination writes roll back. */
  function setPersistence(provider: P, where: CredentialPersistence): void {
    const { session, local } = required();
    const key = tokenKey(provider);
    const grantKey = refreshKey(provider);
    const source = session.getItem(key) !== null ? session : local.getItem(key) !== null ? local : null;
    if (!source) return;
    const target = where === 'browser' ? local : session;
    if (source === target) return;

    const token = source.getItem(key);
    if (token === null) return;
    const grant = session.getItem(grantKey) ?? local.getItem(grantKey);
    const priorToken = target.getItem(key);
    const priorGrant = target.getItem(grantKey);
    try {
      target.setItem(key, token);
      if (grant === null) target.removeItem(grantKey);
      else target.setItem(grantKey, grant);
      if (target.getItem(key) !== token || target.getItem(grantKey) !== grant) {
        throw new Error('Browser storage did not preserve the sign-in.');
      }
    } catch (error) {
      restore(target, key, priorToken);
      restore(target, grantKey, priorGrant);
      throw error;
    }
    source.removeItem(grantKey);
    source.removeItem(key);
  }

  return { read, persistence, store, clear, setPersistence, readRefresh, storeRefresh, clearRefresh };
}

/** True when an access token expiring at `expiresAt` should be refreshed now. */
export function tokenNeedsRefresh(expiresAt: number | undefined, skewMs: number, now = Date.now()): boolean {
  return Boolean(expiresAt && expiresAt - now <= skewMs);
}
