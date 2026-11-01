/**
 * Single-flight credential refresh for providers that rotate the refresh grant (Codex, Claude): two
 * parallel refreshes would sign the driver out. The in-flight promise covers this page; Web Locks
 * (when the browser has them) cover other tabs. The credential is an opaque string the site's vault
 * holds; callers decode it themselves.
 */
export type CredentialRefresherOptions = {
  /** Cross-tab Web Lock name; include a site namespace so unrelated apps on one origin do not contend. */
  lockName: string;
  /** The credential as the vault holds it now (another tab may have refreshed it). */
  readCredential: () => string | null | undefined;
  /** Saves a refreshed credential in the same place. */
  saveCredential: (value: string) => void;
  /** Thrown when the stored credential was removed while a refresh was waiting or running. */
  reconnectError: () => Error;
};

export type CredentialRefresher = {
  /**
   * Returns the credential to use. Runs `refresh` (given the token this refresh started from) under the
   * lock; never overwrites a credential that changed meanwhile; finishes and saves a rotated grant
   * even if this caller aborts, while each caller stops waiting independently.
   */
  refreshed(token: string, refresh: () => Promise<string>, signal?: AbortSignal): Promise<string>;
};

async function waitForCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

export function createCredentialRefresher(options: CredentialRefresherOptions): CredentialRefresher {
  let inflight: Promise<string> | undefined;
  return {
    async refreshed(token, refresh, signal) {
      const run = async (): Promise<string> => {
        const latest = options.readCredential();
        // A reconnect or disconnect may happen while a refresh is queued for the Web Lock.
        // Never send the old account's refresh grant after the stored credential changes.
        if (latest !== token) {
          if (!latest) throw options.reconnectError();
          return latest;
        }
        const next = await refresh();
        // The user may have reconnected or disconnected while the provider rotated the old grant. Do not
        // overwrite that newer choice with the response for the previous account.
        const afterRefresh = options.readCredential();
        if (afterRefresh !== token) {
          if (!afterRefresh) throw options.reconnectError();
          return afterRefresh;
        }
        options.saveCredential(next);
        return next;
      };
      inflight ??= (globalThis.navigator?.locks
        ? (globalThis.navigator.locks.request(options.lockName, { mode: 'exclusive' }, run) as unknown as Promise<string>)
        : run()
      ).finally(() => { inflight = undefined; });
      return waitForCaller(inflight, signal);
    },
  };
}
