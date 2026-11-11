import { ProviderBusyError, providerErrorMessage, sendRetryingWhenBusy, type BusyProvider, type ChatEvent, type ChatRequest } from '@byos/core';
import type { CloudEndpoint } from './endpoints.js';
import { iterateSseEvents } from './sse.js';
import { sourcesFromAnnotations } from './xai-responses.js';

/** A provider's refusal, with the HTTP status so callers can tell "sign in again" (401/403) apart
 * from everything else. The message never includes the credential. */
export class ProviderRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ProviderRequestError';
    this.status = status;
  }
}

export type ProviderErrorKind = 'auth' | 'quota' | 'aborted' | 'unavailable';

const PROVIDER_ERROR_MESSAGES: Record<ProviderErrorKind, string> = {
  auth: 'The provider did not accept this sign-in or key. Reconnect it, then try again.',
  quota: 'The provider refused the request because of credits or rate limits. Check your account, or choose another provider.',
  aborted: 'The request was cancelled.',
  unavailable: 'The provider could not complete this request. Try again later.',
};

/** Sorts a failed provider call for the UI. 401/403 are `auth` (reconnect), 402/429 `quota`, a cancelled
 * fetch (`AbortError`, or an `AbortSignal.timeout` `TimeoutError`) `aborted`, everything else `unavailable`.
 * The status comes from `ProviderRequestError` or any error carrying a numeric `status` (such as
 * `ClaudeAuthError`). `message` is fixed text chosen by `kind`: never the provider's own words, which can
 * echo request data. */
export function classifyProviderError(error: unknown): { kind: ProviderErrorKind; message: string } {
  const name = error && typeof error === 'object' ? (error as { name?: unknown }).name : undefined;
  const status = error && typeof error === 'object' ? (error as { status?: unknown }).status : undefined;
  const kind: ProviderErrorKind = name === 'AbortError' || name === 'TimeoutError' ? 'aborted'
    : status === 401 || status === 403 ? 'auth'
    : status === 402 || status === 429 ? 'quota'
    : 'unavailable';
  return { kind, message: PROVIDER_ERROR_MESSAGES[kind] };
}

/** Reads an error out of a failure body. xAI puts a bare string in `error`; others an object. */
export function providerErrorText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const error = (payload as { error?: unknown }).error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return undefined;
}

export function redactProviderSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let safe = text;
  for (const secret of secrets) if (secret) safe = safe.split(secret).join('[redacted]');
  return safe;
}

export function safeProviderErrorText(payload: unknown, credential: string): string | undefined {
  const text = providerErrorText(payload);
  return text ? redactProviderSecrets(text, [credential]) : undefined;
}

const GENERIC_PROVIDER: BusyProvider = { name: 'The provider', credential: 'api-key' };

/**
 * Sends a provider request with the shared busy rules (@byos/core provider-busy, ported from Skim):
 * a 429/503/529 is asked again after retry-after or a 2 s then 6 s backoff (foreground only), a dropped
 * connection is asked again on a fresh one, a rate limit that outlasts the retries starts a cooldown,
 * and any other failure becomes one sentence a person can act on. Secrets never reach the message.
 */
export async function sendProviderRequest(
  send: () => Promise<Response>,
  options: { provider?: BusyProvider; lane?: 'foreground' | 'background'; signal?: AbortSignal; secrets: readonly (string | undefined)[] },
): Promise<Response> {
  const provider = options.provider ?? GENERIC_PROVIDER;
  let response: Response;
  try {
    response = await sendRetryingWhenBusy(send, { provider, lane: options.lane, signal: options.signal });
  } catch (error) {
    if (error instanceof ProviderBusyError) throw new ProviderRequestError(redactProviderSecrets(error.message, options.secrets), 429);
    throw error;
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ProviderRequestError(redactProviderSecrets(providerErrorMessage(provider, response.status, body, response.headers), options.secrets), response.status);
  }
  return response;
}

type ChunkDelta = { content?: unknown; reasoning?: unknown; reasoning_content?: unknown; annotations?: unknown };
type Chunk = {
  choices?: Array<{ delta?: ChunkDelta }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown };
  error?: unknown;
};

const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);

/**
 * Streams an OpenAI-compatible `POST {baseUrl}/chat/completions` call straight from the browser to
 * the provider, as the kit's common ChatEvent shape. The effort goes out as `reasoning_effort` only
 * when the caller chose one; otherwise the provider applies its own default. `webSearch` is sent only
 * where the endpoint has a search mechanism this function speaks (OpenRouter's `web` plugin); its
 * `url_citation` annotations become `source` events.
 */
export async function* streamChatCompletions(endpoint: CloudEndpoint, request: ChatRequest): AsyncGenerator<ChatEvent> {
  const response = await sendProviderRequest(() => fetch(`${endpoint.baseUrl}/chat/completions`, {
    method: 'POST',
    signal: request.signal,
    redirect: 'error',
    headers: { Authorization: `Bearer ${endpoint.apiKey}`, 'Content-Type': 'application/json', ...endpoint.headers },
    body: JSON.stringify({
      model: request.model,
      messages: request.messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(request.effort ? { reasoning_effort: request.effort } : {}),
      ...(request.webSearch && endpoint.webSearch === 'openrouter-plugin' ? { plugins: [{ id: 'web' }] } : {}),
    }),
  }), { provider: endpoint.busy, lane: request.lane, signal: request.signal, secrets: [endpoint.apiKey] });
  if (!response.body) throw new ProviderRequestError(`${(endpoint.busy ?? GENERIC_PROVIDER).name} sent an empty response. Try again.`, response.status);
  const seen = new Set<string>();
  const reader = response.body.getReader();
  try {
    for await (const event of iterateSseEvents(reader)) {
      if (event.type !== 'data') continue;
      let chunk: Chunk;
      try { chunk = JSON.parse(event.data) as Chunk; } catch { continue; }
      const error = safeProviderErrorText(chunk, endpoint.apiKey);
      if (error) throw new ProviderRequestError(error, 200);
      const delta = chunk.choices?.[0]?.delta;
      const reasoning = delta?.reasoning ?? delta?.reasoning_content;
      if (typeof reasoning === 'string' && reasoning) yield { type: 'reasoning', text: reasoning };
      if (typeof delta?.content === 'string' && delta.content) yield { type: 'text', text: delta.content };
      for (const source of sourcesFromAnnotations(delta?.annotations, seen)) yield { type: 'source', source };
      if (chunk.usage) {
        yield { type: 'usage', inputTokens: count(chunk.usage.prompt_tokens), outputTokens: count(chunk.usage.completion_tokens), costUsd: count(chunk.usage.cost) };
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* A pending read releases it when settled. */ }
  }
  yield { type: 'done' };
}
