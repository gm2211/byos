import type { ByosProvider, CatalogModel, SignInMethod } from '@byos/core';
import { listModelsForEndpoint, listOpenRouterModels } from './catalog.js';
import { ProviderRequestError, streamChatCompletions } from './chat.js';
import {
  createGrokSubscription,
  decodeGrokCredential,
  GrokReconnectRequiredError,
  isGrokSubscriptionRecord,
  type GrokSubscriptionOptions,
} from './grok-sign-in.js';
import { endpointFor, type EndpointOptions } from './endpoints.js';

/**
 * Ready-made ByosProvider adapters for the three browser-direct providers. Each lists models live
 * from the provider and streams chat straight from the browser. TOKEN RULE: the token passed in is
 * sent only to the provider's own host.
 */
const toCatalog = (models: Array<{ id: string; name: string; analysisFit?: string }>): CatalogModel[] =>
  models.map(model => ({ id: model.id, name: model.name, ...(model.analysisFit === 'recommended' ? { recommended: true } : {}) }));

export function openrouter(options: EndpointOptions = {}): ByosProvider {
  return {
    id: 'openrouter',
    displayName: 'OpenRouter',
    // PKCE runs entirely in the browser: OpenRouter's key exchange answers CORS.
    signIn: [{ kind: 'pkce', handshakeViaSite: false }] satisfies SignInMethod[],
    availability: () => ({ available: true }),
    listModels: async (token, signal) => toCatalog(await listOpenRouterModels(token, signal)),
    stream: (token, request) => streamChatCompletions(endpointFor('openrouter', token, options), request),
  };
}

export type GrokProviderOptions = {
  deviceCodeViaSite?: boolean;
  /**
   * Keeps a Grok subscription sign-in alive: refreshes the encoded `grok-subscription:` credential
   * near expiry (single-flight, cross-tab) and once more after a 401. Without it a record token is
   * used until it expires, then the user must reconnect. API keys are never refreshed.
   */
  subscription?: GrokSubscriptionOptions;
};

/**
 * Grok (xAI). TOKEN RULE: only the access token is ever sent to api.x.ai, never the encoded
 * `grok-subscription:` record. A refresh grant goes browser -> auth.x.ai inside browser TLS (the
 * ciphertext `xai-auth` relay destination), or directly from Node/native; never a plaintext relay.
 * 403 is not retried: some SuperGrok tiers answer 403 while signed in.
 */
export function grok(options: GrokProviderOptions = {}): ByosProvider {
  const subscription = options.subscription && createGrokSubscription(options.subscription);

  /** The string to send as the key. */
  async function accessToken(token: string, force: boolean, signal?: AbortSignal): Promise<string> {
    if (subscription) return subscription.accessToken(token, { force, signal });
    if (!isGrokSubscriptionRecord(token)) return token;
    const current = decodeGrokCredential(token);
    if (!current || force || current.expiresAt <= Date.now()) throw new GrokReconnectRequiredError();
    return current.accessToken;
  }

  const retryable = (error: unknown, token: string) =>
    error instanceof ProviderRequestError && error.status === 401 && isGrokSubscriptionRecord(token);

  async function withRetry<T>(token: string, signal: AbortSignal | undefined, run: (key: string) => Promise<T>): Promise<T> {
    const key = await accessToken(token, false, signal);
    try { return await run(key); }
    catch (error) {
      if (!retryable(error, token)) throw error;
      return run(await accessToken(options.subscription?.readCredential() || token, true, signal));
    }
  }

  return {
    id: 'xai',
    displayName: 'Grok',
    signIn: [
      // auth.x.ai sends no CORS headers, so the device-code start/poll needs the site's server once.
      ...(options.deviceCodeViaSite === false ? [] : [{ kind: 'device-code', handshakeViaSite: true } as const]),
      { kind: 'api-key', hint: 'An xAI API key from console.x.ai' },
    ],
    availability: () => ({ available: true }),
    listModels: (token, signal) => withRetry(token, signal, async key => toCatalog(await listModelsForEndpoint(endpointFor('xai', key), signal))),
    async *stream(token, request) {
      const key = await accessToken(token, false, request.signal);
      let started = false;
      try {
        for await (const event of streamChatCompletions(endpointFor('xai', key), request)) { started = true; yield event; }
        return;
      } catch (error) {
        if (started || !retryable(error, token)) throw error;
      }
      const retryKey = await accessToken(options.subscription?.readCredential() || token, true, request.signal);
      yield* streamChatCompletions(endpointFor('xai', retryKey), request);
    },
  };
}

export function groq(): ByosProvider {
  return {
    id: 'groq',
    displayName: 'Groq',
    signIn: [{ kind: 'api-key', hint: 'A Groq API key from console.groq.com' }],
    availability: () => ({ available: true }),
    listModels: async (token, signal) => toCatalog(await listModelsForEndpoint(endpointFor('groq', token), signal)),
    stream: (token, request) => streamChatCompletions(endpointFor('groq', token), request),
  };
}

/** Hugging Face Inference Providers: OpenAI-compatible, billed against the caller's own HF account
 * (free tier / PRO credits, then pay-as-you-go). `clientId` enables browser PKCE sign-in
 * ("Sign in with Hugging Face") -- omit it and only the pasted-access-token path is offered, since
 * PKCE sign-in needs an OAuth client id only the site owner can provision (or a Client ID Metadata
 * Document the site serves itself; see huggingface-sign-in.ts). */
export function huggingface(options: { clientId?: string } = {}): ByosProvider {
  return {
    id: 'huggingface',
    displayName: 'Hugging Face',
    signIn: [
      ...(options.clientId ? [{ kind: 'pkce', handshakeViaSite: false } as const] : []),
      { kind: 'api-key', hint: 'A fine-grained access token from huggingface.co/settings/tokens' },
    ],
    availability: () => ({ available: true }),
    listModels: async (token, signal) => toCatalog(await listModelsForEndpoint(endpointFor('huggingface', token), signal)),
    stream: (token, request) => streamChatCompletions(endpointFor('huggingface', token), request),
  };
}
