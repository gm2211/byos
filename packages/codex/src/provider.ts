/**
 * `codex()`: a ByosProvider for ChatGPT subscriptions. The site passes the browser-owned TLS fetch
 * (@byos/browser-tls createCodexTlsFetch) and where its vault keeps the credential, so a refreshed
 * credential is saved back before the next call. The token handed to listModels/stream is the
 * encoded credential string from pollCodexDeviceSignIn.
 */
import type { ByosProvider, ChatEvent, ChatRequest, SignInMethod } from '@byos/core';
import { buildCodexResponsesBody, CodexRequestError, listCodexModels, readCodexStream, sendCodexResponses } from './responses.js';
import {
  codexNeedsRefresh,
  CodexReconnectRequiredError,
  decodeCodexCredential,
  refreshCodexCredential,
  type CodexCredential,
  type CodexFetch,
} from './sign-in.js';

export type CodexProviderOptions = {
  fetch: CodexFetch;
  /** The credential as the vault holds it now (another tab may have refreshed it). */
  readCredential: () => string | null | undefined;
  /** Saves a refreshed credential in the same place. */
  saveCredential: (value: string) => void;
  /** Site-specific suffix for the cross-tab Web Lock; avoids unrelated apps contending on one origin. */
  namespace?: string;
  /** Shown when the site has no relay (release gate off). */
  unavailableReason?: () => string | undefined;
};

export function codex(options: CodexProviderOptions): ByosProvider {
  // One refresh at a time per browser: OpenAI rotates the refresh grant, so two parallel refreshes
  // would sign the driver out. Web Locks cover tabs; the in-flight promise covers this page.
  let inflight: Promise<string> | undefined;
  const lockName = `byos-codex-refresh:${options.namespace?.trim() || 'default'}`;
  async function waitForCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const aborted = () => reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      signal.addEventListener('abort', aborted, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    });
  }
  async function refreshed(token: string, force: boolean, signal?: AbortSignal): Promise<CodexCredential> {
    const current = decodeCodexCredential(token);
    if (!current) throw new CodexReconnectRequiredError();
    if (!force && !codexNeedsRefresh(current)) return current;
    if (!current.refreshToken) {
      if (force) throw new CodexReconnectRequiredError();
      return current;
    }
    const run = async () => {
      const latest = options.readCredential();
      // A reconnect or disconnect may happen while a refresh is queued for the Web Lock.
      // Never send the old account's refresh grant after the stored credential changes.
      if (latest !== token) {
        if (!latest) throw new CodexReconnectRequiredError();
        return latest;
      }
      // Refresh grant rotates on success. Finish and save it even if one waiting inference is
      // canceled; each caller may stop waiting independently below.
      const next = await refreshCodexCredential(options.fetch, current);
      // The user may have reconnected or disconnected while OpenAI rotated the old grant. Do not
      // overwrite that newer choice with the response for the previous account.
      const afterRefresh = options.readCredential();
      if (afterRefresh !== token) {
        if (!afterRefresh) throw new CodexReconnectRequiredError();
        return afterRefresh;
      }
      options.saveCredential(next);
      return next;
    };
    inflight ??= (globalThis.navigator?.locks
      ? (globalThis.navigator.locks.request(lockName, { mode: 'exclusive' }, run) as unknown as Promise<string>)
      : run()
    ).finally(() => { inflight = undefined; });
    const value = await waitForCaller(inflight, signal);
    const next = decodeCodexCredential(value);
    if (!next) throw new CodexReconnectRequiredError();
    return next;
  }

  async function* stream(token: string, request: ChatRequest): AsyncGenerator<ChatEvent> {
    const body = buildCodexResponsesBody(request.model, request.messages, request.effort);
    let credential = await refreshed(token, false, request.signal);
    let response = await sendCodexResponses(options.fetch, credential, body, request.signal);
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      credential = await refreshed(options.readCredential() || token, true, request.signal);
      response = await sendCodexResponses(options.fetch, credential, body, request.signal);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new CodexRequestError(
        response.status === 401 ? 'ChatGPT rejected this sign-in. Connect it again.'
          : response.status === 403 ? 'This ChatGPT account cannot use the selected model.'
            : `ChatGPT request failed (${response.status}).`,
        response.status,
      );
    }
    const secrets = [token, credential.accessToken, credential.refreshToken ?? '', credential.idToken ?? ''];
    yield* readCodexStream(response, secrets, request.signal);
  }

  return {
    id: 'codex',
    displayName: 'ChatGPT',
    signIn: [{ kind: 'device-code', handshakeViaSite: false }] satisfies SignInMethod[],
    availability: () => {
      const reason = options.unavailableReason?.();
      return reason ? { available: false, reason } : { available: true };
    },
    listModels: async (token, signal) => listCodexModels(options.fetch, await refreshed(token, false, signal), signal),
    stream,
  };
}
