import {
  CLAUDE_CODE_SYSTEM_PREFIX,
  CLAUDE_OAUTH_BETA,
  createCredentialRefresher,
  type ApiKeySetupStep,
  type ByosProvider,
  type CatalogModel,
  type ChatEvent,
  type ChatRequest,
  type ReasoningEffort,
  type SignInMethod,
} from '@byos/core';
import {
  claudeNeedsRefresh,
  ClaudeReconnectRequiredError,
  decodeClaudeCredential,
  isClaudeSubscriptionRecord,
  refreshClaudeCredential,
  type ClaudeCredential,
  type ClaudeTokenFetch,
} from './claude-sign-in.js';
import { ProviderRequestError, safeProviderErrorText } from './chat.js';
import { iterateSseEvents } from './sse.js';

/**
 * Claude (Anthropic) adapter. Talks to api.anthropic.com with an API key (`x-api-key`) or, for a
 * Claude Pro/Max subscription token (`sk-ant-oat…`), with a Bearer header, the OAuth beta flags and the
 * Claude Code system block that such tokens require. Browsers can send those: api.anthropic.com allows
 * Bearer calls from pages. Only Anthropic's token endpoint refuses browsers, so:
 *
 * - In a browser, pass `subscription` (a `claudeTokenRelayFetch` for the host's token relay plus where
 *   the vault keeps the credential) and `signIn` offers the paste-code flow (`beginClaudeSignIn` /
 *   `completeClaudeSignIn`). The credential is the encoded `claude-subscription:` string; this adapter
 *   refreshes it near expiry (single-flight, cross-tab) and once more after a 401.
 * - In Node/native, subscription sign-in is `@byos/claude-local` (Keychain, loopback OAuth with a paste
 *   fallback); this adapter then only spends a raw `sk-ant-oat` token it is handed.
 *
 * `subscriptionsPaused` is an opt-in policy gate for hosts that must refuse subscription tokens
 * (`CLAUDE_SUBSCRIPTIONS_PAUSED_NOTE`). It is off by default: subscription sign-in is supported.
 *
 * PLAN CREDITS. Claude Max and Team plans include monthly Claude API credits
 * (https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers). They land in a linked
 * Claude Console organization and are spent by ordinary API keys, so the sign-in links to the claim
 * page and the key page.
 *
 * TOKEN RULE: the credential goes only to api.anthropic.com. Claude exception (approved 2026-11-01):
 * the code exchange and each refresh grant pass through the host's fixed-destination token relay
 * (the token endpoint blocks browsers); the relay neither stores nor logs them.
 */
export const ANTHROPIC_POLICY_URL = 'https://code.claude.com/docs/en/legal-and-compliance';
export const CLAUDE_PLAN_CREDITS_URL = 'https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers';
/** Where a user gets a key: claim Max/Team plan credits (optional), then create the key. */
export const CLAUDE_API_KEY_SETUP: ApiKeySetupStep[] = [
  { label: 'Claim your Max or Team plan’s API credits (optional)', url: 'https://claude.ai/settings/billing' },
  { label: 'Create an API key in Claude Console', url: 'https://platform.claude.com/settings/keys' },
];
export const CLAUDE_SUBSCRIPTIONS_PAUSED_NOTE = 'This app has paused Claude subscription sign-in. Use an API key, or pick another service.';
/** Beta flags and system block a subscription Bearer token needs (defined in @byos/core). */
export { CLAUDE_OAUTH_BETA, CLAUDE_CODE_SYSTEM_PREFIX };

const API = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
const EFFORT_ORDER: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const MAX_PAGES = 5;

/** Anything that is not an `sk-ant-api…` key is a subscription (OAuth) credential. */
export function isClaudeSubscriptionCredential(raw: string): boolean {
  const token = raw.trim();
  return Boolean(token) && !(token.startsWith('sk-ant-') && !token.startsWith('sk-ant-oat'));
}

export function claudeCredentialAllowed(raw: string, subscriptionsPaused = false): boolean {
  return !(subscriptionsPaused && isClaudeSubscriptionCredential(raw));
}

function headers(key: string, json: boolean): Record<string, string> {
  const subscription = isClaudeSubscriptionCredential(key);
  return {
    ...(subscription ? { Authorization: `Bearer ${key.trim()}`, 'anthropic-beta': CLAUDE_OAUTH_BETA } : { 'x-api-key': key }),
    'anthropic-version': ANTHROPIC_VERSION,
    // Anthropic requires this opt-in for calls made straight from a browser page.
    'anthropic-dangerous-direct-browser-access': 'true',
    ...(json ? { 'content-type': 'application/json' } : {}),
  };
}

type AnthropicModelRow = {
  id?: unknown;
  display_name?: unknown;
  capabilities?: { effort?: Record<string, unknown> & { supported?: unknown } };
};

/** One page of GET /v1/models to picker rows, with each model's supported effort levels. */
export function parseAnthropicModels(rows: unknown): CatalogModel[] {
  if (!Array.isArray(rows)) return [];
  const models: CatalogModel[] = [];
  for (const raw of rows as AnthropicModelRow[]) {
    if (!raw || typeof raw.id !== 'string' || !raw.id.trim() || /\s/.test(raw.id)) continue;
    const effort = raw.capabilities?.effort;
    const efforts = effort && effort.supported === true
      ? EFFORT_ORDER.filter(level => (effort[level] as { supported?: unknown } | undefined)?.supported === true)
      : [];
    models.push({
      id: raw.id,
      name: typeof raw.display_name === 'string' && raw.display_name.trim() ? raw.display_name : raw.id,
      ...(efforts.length ? { reasoningEfforts: efforts.map(level => ({ effort: level })) } : {}),
    });
  }
  return models;
}

function requireKey(key: string, paused: boolean): void {
  if (!claudeCredentialAllowed(key, paused)) throw new ProviderRequestError(CLAUDE_SUBSCRIPTIONS_PAUSED_NOTE, 403);
}

export async function listClaudeModels(key: string, signal?: AbortSignal, subscriptionsPaused = false): Promise<CatalogModel[]> {
  requireKey(key, subscriptionsPaused);
  const models: CatalogModel[] = [];
  let after = '';
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await fetch(`${API}/models?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ''}`, { headers: headers(key, false), signal, redirect: 'error' });
    const payload = await response.json().catch(() => ({})) as { data?: unknown; has_more?: unknown; last_id?: unknown };
    if (!response.ok) throw new ProviderRequestError(safeProviderErrorText(payload, key) ?? `Claude model list failed (${response.status}).`, response.status);
    models.push(...parseAnthropicModels(payload.data));
    if (payload.has_more !== true || typeof payload.last_id !== 'string') break;
    after = payload.last_id;
  }
  return models;
}

/** Streams POST /v1/messages as ChatEvents. System messages become the top-level `system`. */
export async function* streamClaude(key: string, request: ChatRequest, subscriptionsPaused = false): AsyncGenerator<ChatEvent> {
  requireKey(key, subscriptionsPaused);
  const userSystem = request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
  // Subscription tokens are honored only when the system prompt opens with the Claude Code block.
  const system = isClaudeSubscriptionCredential(key) ? [{ type: 'text', text: CLAUDE_CODE_SYSTEM_PREFIX }, ...(userSystem ? [{ type: 'text', text: userSystem }] : [])] : userSystem;
  const response = await fetch(`${API}/messages`, {
    method: 'POST',
    signal: request.signal,
    redirect: 'error',
    headers: headers(key, true),
    body: JSON.stringify({
      model: request.model,
      max_tokens: 16_000,
      stream: true,
      ...(system.length ? { system } : {}),
      messages: request.messages.filter(message => message.role !== 'system').map(({ role, content }) => ({ role, content })),
      // Effort only when chosen and listed for the model; some models reject the field outright.
      ...(request.effort ? { thinking: { type: 'adaptive' }, output_config: { effort: request.effort } } : {}),
    }),
  });
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => undefined);
    throw new ProviderRequestError(safeProviderErrorText(payload, key) ?? `Claude answered ${response.status}.`, response.status);
  }
  let inputTokens: number | undefined;
  const reader = response.body.getReader();
  try {
    for await (const event of iterateSseEvents(reader)) {
      if (event.type !== 'data') continue;
      let data: { type?: string; delta?: { type?: string; text?: unknown; thinking?: unknown }; message?: { usage?: { input_tokens?: unknown } }; usage?: { output_tokens?: unknown }; error?: unknown };
      try { data = JSON.parse(event.data); } catch { continue; }
      if (data.type === 'error') throw new ProviderRequestError(safeProviderErrorText(data, key) ?? 'Claude stopped with an error.', 200);
      if (data.type === 'message_start' && typeof data.message?.usage?.input_tokens === 'number') inputTokens = data.message.usage.input_tokens;
      if (data.type === 'content_block_delta') {
        if (data.delta?.type === 'text_delta' && typeof data.delta.text === 'string') yield { type: 'text', text: data.delta.text };
        if (data.delta?.type === 'thinking_delta' && typeof data.delta.thinking === 'string') yield { type: 'reasoning', text: data.delta.thinking };
      }
      if (data.type === 'message_delta' && typeof data.usage?.output_tokens === 'number') {
        yield { type: 'usage', inputTokens, outputTokens: data.usage.output_tokens };
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* A pending read releases it when settled. */ }
  }
  yield { type: 'done' };
}

const API_KEY_METHOD: SignInMethod = {
  kind: 'api-key',
  hint: 'A Claude API key from platform.claude.com. Max and Team plans include monthly API credits for it.',
  setup: CLAUDE_API_KEY_SETUP,
};

export type ClaudeSubscriptionOptions = {
  /** `claudeTokenRelayFetch({ path })`: how refresh grants reach Anthropic's token endpoint. */
  tokenFetch: ClaudeTokenFetch;
  /** The credential as the vault holds it now (another tab may have refreshed it). */
  readCredential: () => string | null | undefined;
  /** Saves a refreshed credential in the same place. */
  saveCredential: (value: string) => void;
  /** Site-specific suffix for the cross-tab Web Lock. */
  namespace?: string;
};

export type ClaudeProviderOptions = {
  subscriptionsPaused?: boolean;
  /** Browser subscription sign-in and refresh. Without it only API keys and raw issued tokens are offered. */
  subscription?: ClaudeSubscriptionOptions;
};

export function claude(options: ClaudeProviderOptions = {}): ByosProvider {
  const paused = options.subscriptionsPaused ?? false;
  const subscription = options.subscription;
  const refresher = subscription && createCredentialRefresher({
    lockName: `byos-claude-refresh:${subscription.namespace?.trim() || 'default'}`,
    readCredential: () => subscription.readCredential(),
    saveCredential: value => subscription.saveCredential(value),
    reconnectError: () => new ClaudeReconnectRequiredError(),
  });

  /** The string to send as the key: an encoded record becomes its (refreshed) access token. */
  async function accessToken(token: string, force: boolean, signal?: AbortSignal): Promise<string> {
    requireKey(token, paused);
    if (!isClaudeSubscriptionRecord(token)) return token;
    const current: ClaudeCredential | undefined = decodeClaudeCredential(token);
    if (!current) throw new ClaudeReconnectRequiredError();
    const expired = current.expiresAt <= Date.now();
    if (!force && !claudeNeedsRefresh(current)) return current.accessToken;
    if (!subscription || !refresher || !current.refreshToken) {
      if (force || expired) throw new ClaudeReconnectRequiredError();
      return current.accessToken;
    }
    const value = await refresher.refreshed(token, () => refreshClaudeCredential(subscription.tokenFetch, current), signal);
    const next = decodeClaudeCredential(value);
    if (!next) throw new ClaudeReconnectRequiredError();
    return next.accessToken;
  }

  /** One forced refresh and retry when Anthropic answers 401 before anything was produced. */
  async function withRetry<T>(token: string, signal: AbortSignal | undefined, run: (key: string) => Promise<T>): Promise<T> {
    const key = await accessToken(token, false, signal);
    try { return await run(key); }
    catch (error) {
      if (!(error instanceof ProviderRequestError) || error.status !== 401 || !isClaudeSubscriptionRecord(token)) throw error;
      return run(await accessToken(subscription?.readCredential() || token, true, signal));
    }
  }

  return {
    id: 'claude',
    displayName: 'Claude',
    signIn: subscription && !paused
      ? [{ kind: 'pkce', handshakeViaSite: true, completion: 'paste-code' }, API_KEY_METHOD]
      : [API_KEY_METHOD],
    availability: () => ({ available: true }),
    listModels: (token, signal) => withRetry(token, signal, key => listClaudeModels(key, signal, paused)),
    async *stream(token, request) {
      const key = await accessToken(token, false, request.signal);
      const first = streamClaude(key, request, paused);
      let started = false;
      try {
        for await (const event of first) { started = true; yield event; }
        return;
      } catch (error) {
        if (started || !(error instanceof ProviderRequestError) || error.status !== 401 || !isClaudeSubscriptionRecord(token)) throw error;
      }
      const retryKey = await accessToken(subscription?.readCredential() || token, true, request.signal);
      yield* streamClaude(retryKey, request, paused);
    },
  };
}

/** Claude Opus/Sonnet 4.7 and later, and every 5-series model, answer a `temperature` field with a 400.
 *  True only for Claude 3.x and 4.0-4.6; an unrecognised model gets the API's default sampling instead of
 *  a failure. Ported from skim's `anthropic_accepts_temperature`. */
export function claudeAcceptsTemperature(model: string): boolean {
  const parts = model.toLowerCase().split('-');
  if (parts.shift() !== 'claude') return false;
  // "claude-3-5-sonnet-…" names the version first; "claude-sonnet-4-6" the family first.
  if (parts[0] !== undefined && !/^\d+$/.test(parts[0])) parts.shift();
  if (!/^\d+$/.test(parts[0] ?? '')) return false;
  const major = Number(parts[0]);
  if (major <= 3) return true;
  if (major !== 4) return false;
  // A 1-2 digit part is the minor version; a date snapshot ("4-20250514") is 4.0.
  const next = parts[1];
  const minor = next !== undefined && next.length <= 2 && /^\d+$/.test(next) ? Number(next) : 0;
  return minor <= 6;
}
