import type { CloudEndpoint } from './endpoints.js';
import { PROVIDER_BASE_URLS } from './endpoints.js';
import { ProviderRequestError, safeProviderErrorText } from './chat.js';

export type OpenRouterKeyInfo = {
  label?: string;
  usage?: number;
  limit?: number | null;
};

/** A model as the picker lists it. */
export type ProviderModel = {
  id: string;
  name: string;
  analysisFit: 'recommended' | 'balanced' | 'lightweight' | 'standard';
  /** USD per million tokens, from OpenRouter's per-token pricing. Undefined when no usable price. */
  promptPerMillion?: number;
  completionPerMillion?: number;
  contextLength?: number;
  /** Whether the model accepts a reasoning effort at request time (from supported_parameters). */
  reasoning: boolean;
};
/** Motive's historical name for ProviderModel. */
export type OpenRouterModel = ProviderModel;

export class OpenRouterAuthenticationError extends ProviderRequestError {
  constructor(status = 401) {
    super('OpenRouter rejected this key. Reconnect your OpenRouter account.', status);
    this.name = 'OpenRouterAuthenticationError';
  }
}

function rejectInvalidCredential(status: number): void {
  if (status === 401 || status === 403) throw new OpenRouterAuthenticationError(status);
}

const API_ROOT = PROVIDER_BASE_URLS.openrouter;

/** OpenRouter quotes prices per token as strings ("0.000001"). Anything non-numeric or negative is
 * treated as "no usable price" rather than shown as $0, which would read as free. */
function perMillion(value: unknown): number | undefined {
  const perToken = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(perToken) && perToken >= 0 ? perToken * 1_000_000 : undefined;
}

function analysisFit(id: string, name: string): OpenRouterModel['analysisFit'] {
  const value = `${id} ${name}`.toLowerCase();
  if (/gpt-5\.[2-9]|claude.*(?:opus|sonnet).*4|gemini.*(?:3|3\.1).*pro|grok-4|sonar-pro|deep-research/.test(value)) return 'recommended';
  if (/gpt-5|claude.*sonnet|gemini.*flash(?!.*lite)|o3|o4-mini|sonar/.test(value)) return 'balanced';
  if (/lite|nano|haiku|flash-lite|\bfree\b/.test(value)) return 'lightweight';
  return 'standard';
}

function fitRank(fit: OpenRouterModel['analysisFit']): number {
  return { recommended: 0, balanced: 1, standard: 2, lightweight: 3 }[fit];
}

export async function readOpenRouterKeyInfo(key: string, signal?: AbortSignal): Promise<OpenRouterKeyInfo> {
  const response = await fetch(`${API_ROOT}/key`, { signal, redirect: 'error', headers: { Authorization: `Bearer ${key}` } });
  rejectInvalidCredential(response.status);
  const payload = await response.json().catch(() => ({})) as { data?: OpenRouterKeyInfo; error?: { message?: string } };
  if (!response.ok) throw new ProviderRequestError(safeProviderErrorText(payload, key) || 'OpenRouter rejected this key.', response.status);
  return payload.data ?? {};
}

export async function listOpenRouterModels(key: string, signal?: AbortSignal): Promise<OpenRouterModel[]> {
  const response = await fetch(`${API_ROOT}/models`, { signal, redirect: 'error', headers: { Authorization: `Bearer ${key}` } });
  rejectInvalidCredential(response.status);
  const payload = await response.json().catch(() => ({})) as {
    data?: Array<{
      id?: string;
      name?: string;
      supported_parameters?: string[];
      context_length?: number;
      pricing?: { prompt?: string | number; completion?: string | number };
    }>;
    error?: { message?: string };
  };
  if (!response.ok) throw new ProviderRequestError(safeProviderErrorText(payload, key) || 'Could not load OpenRouter models.', response.status);
  return (payload.data ?? [])
    .filter(model => model.id && model.supported_parameters?.includes('tools'))
    .map(model => {
      const name = model.name || model.id!;
      return {
        id: model.id!,
        name,
        analysisFit: analysisFit(model.id!, name),
        promptPerMillion: perMillion(model.pricing?.prompt),
        completionPerMillion: perMillion(model.pricing?.completion),
        contextLength: typeof model.context_length === 'number' && model.context_length > 0 ? model.context_length : undefined,
        reasoning: Boolean(model.supported_parameters?.includes('reasoning')),
      };
    })
    .sort((a, b) => fitRank(a.analysisFit) - fitRank(b.analysisFit) || a.name.localeCompare(b.name));
}

/** Id words that mark a model as image, video, audio, embedding or moderation rather than text chat,
 * such as xAI's `grok-imagine-image` and `grok-imagine-video`. OpenAI-compatible `/models` lists carry
 * no modality, so the id is all there is to go on. */
const NON_CHAT_MODEL_WORDS = new Set(['imagine', 'image', 'video', 'embed', 'embedding', 'tts', 'whisper', 'dall', 'moderation', 'transcribe', 'sora', 'realtime', 'audio', 'speech', 'imagen', 'banana', 'veo', 'lyria']);

/** False for ids of models that cannot answer a chat request (see NON_CHAT_MODEL_WORDS). */
export function isChatModel(id: string): boolean {
  return !id.toLowerCase().split(/[^a-z0-9]+/).some(word => NON_CHAT_MODEL_WORDS.has(word));
}

/** A dated build of a model, such as xAI's `grok-4.20-0309-reasoning`: a 4-or-more digit segment (MMDD or YYYYMMDD) in the id. */
const DATED_SEGMENT = /(?:^|-)\d{4,8}(?:-|$)/;

/** True for a dated build, or one with a plain-word qualifier after the version (`-reasoning`,
 * `-non-reasoning`, `-multi-agent`, `-mini`), as opposed to the undated flagship alias. */
function isVariantId(id: string): boolean {
  if (DATED_SEGMENT.test(id)) return true;
  const parts = id.toLowerCase().split('-');
  const firstVersion = parts.findIndex(part => /\d/.test(part));
  return firstVersion !== -1 && parts.slice(firstVersion + 1).some(part => /^[a-z]+$/.test(part));
}

/** The numeric version segments of an id, ignoring date segments: `grok-4.20-0309-reasoning` is [4, 20]. */
function versionOf(id: string): number[] {
  return id.split('-').filter(part => !/^\d{4,8}$/.test(part)).flatMap(part => part.match(/\d+/g) ?? []).map(Number);
}

/** Positive when version `a` is older than `b`, comparing segment by segment (4.3 < 4.20 < 5). */
function compareVersionsDescending(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (b[i] ?? -1) - (a[i] ?? -1);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Orders an OpenAI-compatible `/models` list newest first. The primary key is each entry's `created`
 * timestamp (xAI lists ids alphabetically, so `grok-4.20-0309-*` would otherwise sit above `grok-4.7`).
 * When `created` is missing or tied, undated builds come before dated or variant ones (isVariantId),
 * and within each group the higher version comes first (versionOf). The undated/dated split must
 * come before the version compare because xAI's 4.20 predates 4.3. Entries without a `created` value
 * sort after those with one; remaining ties keep the provider's order.
 */
function newestFirst<T extends { id: string; created?: unknown }>(models: T[]): T[] {
  const createdAt = (model: T) => typeof model.created === 'number' && Number.isFinite(model.created) ? model.created : -Infinity;
  return models
    .map((model, index) => ({ model, index, created: createdAt(model), variant: isVariantId(model.id) ? 1 : 0, version: versionOf(model.id) }))
    .sort((a, b) => (a.created === b.created ? 0 : b.created > a.created ? 1 : -1) || a.variant - b.variant || compareVersionsDescending(a.version, b.version) || a.index - b.index)
    .map(entry => entry.model);
}

/**
 * listOpenRouterModels' sibling for xAI and Groq: the same `GET {baseUrl}/models` OpenAI-compatible
 * route every browser-direct endpoint answers (see endpoints.ts). Deliberately simpler than
 * listOpenRouterModels above rather than sharing its body: xAI/Groq's `/models` responses carry
 * neither OpenRouter's `supported_parameters` nor its per-token `pricing` block, so guessing either
 * would just be fabricating a number this response never sent. Repeats and non-chat models
 * (isChatModel) are dropped, and the rest are listed newest first (newestFirst). `analysisFit` stays
 * 'standard' across the board rather than reusing OpenRouter's name-sniffing heuristic, which was
 * tuned against OpenRouter's own model-name conventions (e.g. "sonar-pro").
 */
export async function listModelsForEndpoint(endpoint: CloudEndpoint, signal?: AbortSignal): Promise<OpenRouterModel[]> {
  const response = await fetch(`${endpoint.baseUrl}/models`, { signal, redirect: 'error', headers: { Authorization: `Bearer ${endpoint.apiKey}`, ...endpoint.headers } });
  const payload = await response.json().catch(() => ({})) as {
    data?: Array<{ id?: string; name?: string; created?: unknown }>;
    error?: { message?: string };
  };
  if (!response.ok) throw new ProviderRequestError(safeProviderErrorText(payload, endpoint.apiKey) || 'Could not load models.', response.status);
  const seen = new Set<string>();
  return newestFirst((payload.data ?? [])
    .filter((model): model is { id: string; name?: string; created?: unknown } => {
      if (!model.id || !isChatModel(model.id) || seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    }))
    .map(model => ({ id: model.id, name: model.name || model.id, analysisFit: 'standard' as const, reasoning: false }));
}
