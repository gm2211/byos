/**
 * ChatGPT (Codex) Responses streaming and account model list, over the browser-owned TLS fetch.
 * Ported from Motive's web/src/codex-responses.ts and codex-model-catalog.ts: same endpoint, body
 * shape, headers, size limits, credential-echo guard and final-answer selection. Tool calls, web
 * search and images are left out; this adapter is plain chat.
 */
import type { CatalogModel, ChatEvent, ChatMessage, ReasoningEffort } from '@byos/core';
import { iterateSseEvents } from '@byos/providers';
import { codexAccountId, isRecord, type CodexCredential, type CodexFetch } from './sign-in.js';

export const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
export const CODEX_ACCOUNT_CATALOG_URL = 'https://chatgpt.com/backend-api/codex/models?client_version=0.153.2';
const MAX_PROMPT_CHARS = 1_000_000;
const MAX_REQUEST_BYTES = 15 * 1024 * 1024;
const MAX_STREAM_TEXT_CHARS = 4 * 1024 * 1024;
const MAX_SSE_EVENT_CHARS = 2 * 1024 * 1024;
const MAX_SSE_TOTAL_CHARS = 16 * 1024 * 1024;
const MAX_SSE_EVENTS = 100_000;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const EFFORTS = new Set<ReasoningEffort>(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

export class CodexRequestError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
    this.name = 'CodexRequestError';
  }
}

function headersFor(credential: CodexCredential, accept: string): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${credential.accessToken}`, Accept: accept };
  const account = codexAccountId(credential);
  if (account) headers['ChatGPT-Account-Id'] = account;
  return headers;
}

/** The Responses body: system messages become `instructions`, the rest the conversation. */
export function buildCodexResponsesBody(model: string, messages: ChatMessage[], effort?: ReasoningEffort): Record<string, unknown> {
  if (!model || model.length > 128 || /\s/.test(model)) throw new CodexRequestError('Choose a valid ChatGPT model first.');
  const instructions = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const input = messages.filter(m => m.role !== 'system').map(m => ({
    type: 'message',
    role: m.role,
    content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: m.content }],
  }));
  const chars = instructions.length + messages.reduce((n, m) => n + m.content.length, 0);
  if (chars > MAX_PROMPT_CHARS || !input.length) throw new CodexRequestError('This ChatGPT request is too large.');
  return {
    model,
    instructions,
    input,
    tools: [],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    ...(effort && effort !== 'none' && EFFORTS.has(effort) ? { reasoning: { effort } } : {}),
  };
}

export async function sendCodexResponses(fetch: CodexFetch, credential: CodexCredential, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  const serialized = JSON.stringify(body);
  if (new TextEncoder().encode(serialized).byteLength > MAX_REQUEST_BYTES) throw new CodexRequestError('This ChatGPT request is too large.');
  return fetch(CODEX_RESPONSES_URL, {
    method: 'POST',
    headers: { ...headersFor(credential, 'text/event-stream'), 'Content-Type': 'application/json' },
    body: serialized,
    credentials: 'omit',
    redirect: 'error',
    signal,
  });
}

type Phase = 'commentary' | 'final_answer' | 'none';
const phaseOf = (value: unknown): Phase => (value === 'commentary' || value === 'final_answer' ? value : 'none');

function messageText(item: Record<string, unknown>): string {
  if (item.role !== undefined && item.role !== 'assistant') return '';
  if (!Array.isArray(item.content)) return '';
  let text = '';
  for (const part of item.content) {
    if (!isRecord(part)) continue;
    if (part.type === 'refusal') throw new CodexRequestError('ChatGPT could not complete this request.');
    if (part.type === 'output_text' && typeof part.text === 'string') text += part.text;
  }
  return text;
}

/**
 * Reads a Responses SSE stream as ChatEvents. Answer text streams as it arrives, except items the
 * backend marks as commentary; if nothing streamed, the final text is sent once at the end, chosen
 * as Motive does (final-answer items, then other items, then the completed output).
 */
export async function* readCodexStream(response: Response, secrets: string[], signal?: AbortSignal): AsyncGenerator<ChatEvent> {
  if (!response.body) throw new CodexRequestError('ChatGPT returned no response stream.');
  const reader = response.body.getReader();
  const phaseById = new Map<string, Phase>();
  const items: Array<{ phase: Phase; text: string }> = [];
  let streamed = 0, events = 0, total = 0, completedText = '', completed = false;
  try {
    for await (const event of iterateSseEvents(reader)) {
      signal?.throwIfAborted();
      if (++events > MAX_SSE_EVENTS) throw new CodexRequestError('ChatGPT returned too many stream events.');
      if (event.type !== 'data') continue;
      total += event.data.length;
      if (event.data.length > MAX_SSE_EVENT_CHARS || total > MAX_SSE_TOTAL_CHARS) throw new CodexRequestError('ChatGPT returned a response that was too large.');
      let payload: unknown;
      try { payload = JSON.parse(event.data); } catch { throw new CodexRequestError('ChatGPT returned an invalid response stream.'); }
      if (!isRecord(payload) || typeof payload.type !== 'string') continue;
      // Never let an echoed credential reach the page's text.
      if (secrets.some(secret => secret && event.data.includes(secret))) throw new CodexRequestError('ChatGPT returned an invalid response. Try again.');
      const type = payload.type;
      if (type === 'error' || type === 'response.failed' || type === 'response.incomplete') {
        throw new CodexRequestError('ChatGPT could not complete this request.', response.status);
      }
      const item = isRecord(payload.item) ? payload.item : undefined;
      if (item && ['function_call', 'custom_tool_call', 'mcp_call'].includes(String(item.type))) {
        throw new CodexRequestError('ChatGPT returned an unsupported tool request.');
      }
      if (type === 'response.output_item.added' && item?.type === 'message' && typeof item.id === 'string') {
        phaseById.set(item.id, phaseOf(item.phase));
      } else if (type === 'response.output_item.done' && item?.type === 'message') {
        const text = messageText(item);
        const phase = phaseOf(item.phase) !== 'none' ? phaseOf(item.phase) : typeof item.id === 'string' ? phaseById.get(item.id) ?? 'none' : 'none';
        if (text) items.push({ phase, text });
      } else if (type === 'response.output_text.delta' && typeof payload.delta === 'string') {
        const phase = typeof payload.item_id === 'string' ? phaseById.get(payload.item_id) ?? 'none' : 'none';
        if (phase !== 'commentary' && payload.delta) {
          streamed += payload.delta.length;
          if (streamed > MAX_STREAM_TEXT_CHARS) throw new CodexRequestError('ChatGPT returned a response that was too large.');
          yield { type: 'text', text: payload.delta };
        }
      } else if (type === 'response.completed' || type === 'response.done') {
        const r = isRecord(payload.response) ? payload.response : undefined;
        if (!r || r.status !== 'completed' || r.incomplete_details) throw new CodexRequestError('ChatGPT returned an incomplete response.');
        if (Array.isArray(r.output)) {
          for (const out of r.output) if (isRecord(out) && out.type === 'message') completedText += messageText(out);
        }
        if (isRecord(r.usage)) {
          const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
          yield { type: 'usage', inputTokens: n(r.usage.input_tokens), outputTokens: n(r.usage.output_tokens) };
        }
        completed = true;
        break;
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* an outstanding read releases it */ }
  }
  if (!completed) throw new CodexRequestError('ChatGPT response ended before completion.');
  if (!streamed) {
    const finals = items.filter(i => i.phase === 'final_answer');
    const others = items.filter(i => i.phase !== 'commentary');
    const pool = finals.length ? finals : others.length ? others : items;
    const text = pool.length ? pool.map(i => i.text).join('\n\n') : completedText;
    if (!text.trim()) throw new CodexRequestError('ChatGPT completed without a usable answer.');
    yield { type: 'text', text };
  }
  yield { type: 'done' };
}

/** Parses the Codex models JSON, keeping API-supported rows (hidden ones marked hidden). */
export function parseCodexModelCatalog(raw: unknown): CatalogModel[] {
  if (!isRecord(raw) || !Array.isArray(raw.models)) return [];
  const seen = new Set<string>();
  const models: CatalogModel[] = [];
  for (const entry of raw.models) {
    if (!isRecord(entry)) continue;
    const id = typeof (entry.slug ?? entry.id) === 'string' ? String(entry.slug ?? entry.id).trim() : '';
    if (!id || id.length > 128 || /\s/.test(id) || entry.supported_in_api !== true || seen.has(id.toLowerCase())) continue;
    const reasoningEfforts: Array<{ effort: ReasoningEffort; description?: string }> = [];
    for (const level of Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : []) {
      if (!isRecord(level) || !EFFORTS.has(level.effort as ReasoningEffort)) continue;
      if (reasoningEfforts.some(e => e.effort === level.effort)) continue;
      reasoningEfforts.push(typeof level.description === 'string' && level.description.trim()
        ? { effort: level.effort as ReasoningEffort, description: level.description.trim() }
        : { effort: level.effort as ReasoningEffort });
    }
    const def = EFFORTS.has(entry.default_reasoning_level as ReasoningEffort) ? entry.default_reasoning_level as ReasoningEffort : undefined;
    const name = typeof entry.display_name === 'string' && entry.display_name.trim() ? entry.display_name.trim() : id;
    models.push({
      id,
      name,
      reasoningEfforts,
      ...(def ? { defaultReasoningEffort: def } : {}),
      ...(String(entry.visibility ?? '').toLowerCase() === 'hide' ? { hidden: true } : {}),
    });
    seen.add(id.toLowerCase());
  }
  return models;
}

/** The models this ChatGPT account may use, from OpenAI (never a hard-coded list). */
export async function listCodexModels(fetch: CodexFetch, credential: CodexCredential, signal?: AbortSignal): Promise<CatalogModel[]> {
  const response = await fetch(CODEX_ACCOUNT_CATALOG_URL, {
    method: 'GET', headers: headersFor(credential, 'application/json'), credentials: 'omit', cache: 'no-store', redirect: 'error', signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new CodexRequestError(`ChatGPT's model list request failed (${response.status}).`, response.status);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_CATALOG_BYTES) throw new CodexRequestError("ChatGPT's model list is too large.");
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)); } catch { throw new CodexRequestError("ChatGPT's model list was invalid."); }
  const models = parseCodexModelCatalog(payload);
  if (!models.length) throw new CodexRequestError('ChatGPT listed no models this account can use.');
  return models;
}
