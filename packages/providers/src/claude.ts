import type { ApiKeySetupStep, ByosProvider, CatalogModel, ChatEvent, ChatRequest, ReasoningEffort } from '@byos/core';
import { ProviderRequestError, safeProviderErrorText } from './chat.js';
import { iterateSseEvents } from './sse.js';

/**
 * Claude (Anthropic) adapter. Talks to api.anthropic.com with an API key (`x-api-key`) or, for a
 * Claude Pro/Max subscription token (`sk-ant-oat…`), with a Bearer header, the OAuth beta flags and the
 * Claude Code system block that such tokens require. Subscription sign-in itself is `@byos/claude-local`
 * (Node, Keychain, loopback OAuth with a paste fallback); this adapter only spends a token it is handed.
 * Browsers usually cannot send subscription tokens (CORS), so use them from a Node/native host.
 *
 * `subscriptionsPaused` is an opt-in policy gate for hosts that must refuse subscription tokens
 * (`CLAUDE_SUBSCRIPTIONS_PAUSED_NOTE`). It is off by default: subscription sign-in is supported.
 *
 * PLAN CREDITS. Claude Max and Team plans include monthly Claude API credits
 * (https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers). They land in a linked
 * Claude Console organization and are spent by ordinary API keys, so the sign-in links to the claim
 * page and the key page.
 *
 * TOKEN RULE: the credential goes only to api.anthropic.com.
 */
export const ANTHROPIC_POLICY_URL = 'https://code.claude.com/docs/en/legal-and-compliance';
export const CLAUDE_PLAN_CREDITS_URL = 'https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers';
/** Where a user gets a key: claim Max/Team plan credits (optional), then create the key. */
export const CLAUDE_API_KEY_SETUP: ApiKeySetupStep[] = [
  { label: 'Claim your Max or Team plan’s API credits (optional)', url: 'https://claude.ai/settings/billing' },
  { label: 'Create an API key in Claude Console', url: 'https://platform.claude.com/settings/keys' },
];
export const CLAUDE_SUBSCRIPTIONS_PAUSED_NOTE = 'This app has paused Claude subscription sign-in. Use an API key, or pick another service.';
/** Beta flags and system block a subscription Bearer token needs. */
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20,claude-code-20250219';
export const CLAUDE_CODE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

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

export function claude(options: { subscriptionsPaused?: boolean } = {}): ByosProvider {
  const paused = options.subscriptionsPaused ?? false;
  return {
    id: 'claude',
    displayName: 'Claude',
    signIn: [{ kind: 'api-key', hint: 'A Claude API key from platform.claude.com. Max and Team plans include monthly API credits for it.', setup: CLAUDE_API_KEY_SETUP }],
    // Pro/Max subscription sign-in is @byos/claude-local (Node); this adapter takes the API key or an issued token.
    availability: () => ({ available: true }),
    listModels: (token, signal) => listClaudeModels(token, signal, paused),
    stream: (token, request) => streamClaude(token, request, paused),
  };
}
