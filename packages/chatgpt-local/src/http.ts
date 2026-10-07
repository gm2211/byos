import { ChatGptError, checkSignal, httpError } from './errors.js';
export const ISSUER = 'https://auth.openai.com';
export const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
export const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
export const RESOURCE = 'https://api.openai.com/v1';
export const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
export const text = (x: unknown, max = 32_768): x is string => typeof x === 'string' && x.length > 0 && x.length <= max && !/[\u0000-\u001f\u007f]/.test(x);
export function authEndpoint(value: unknown): string {
  if (!text(value)) throw new ChatGptError('auth-failed');
  const u = new URL(value);
  if (u.origin !== ISSUER || u.username || u.password || u.hash || u.search) throw new ChatGptError('auth-failed');
  return u.href;
}
export async function request(fetcher: typeof fetch, url: string, init: RequestInit, signal?: AbortSignal, timeoutMs = 30_000): Promise<Response> {
  checkSignal(signal);
  try { return await fetcher(url, { ...init, redirect: 'error', credentials: 'omit', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]) }); }
  catch { checkSignal(signal); throw new ChatGptError('unavailable'); }
}
export async function json(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new ChatGptError('invalid-response');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 2 * 1024 * 1024) throw new ChatGptError('invalid-response'); chunks.push(value); }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!record(result)) throw new ChatGptError('invalid-response'); return result;
  } catch { throw new ChatGptError('invalid-response'); }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export function providerError(value: unknown, status?: number): ChatGptError {
  const payload = record(value) ? value : {};
  const error = record(payload.error) ? payload.error : payload;
  const code = String(error.code ?? error.type ?? '');
  if (['usage_limit_reached', 'rate_limit_exceeded', 'insufficient_quota', 'subscription_sharing_usage_limit_exceeded'].includes(code)) return new ChatGptError('quota', status);
  if (['subscription_sharing_usage_unavailable', 'server_error', 'temporarily_unavailable'].includes(code)) return new ChatGptError('unavailable', status);
  if (['insufficient_scope', 'subscription_sharing_not_enabled'].includes(code)) return new ChatGptError('consent-required', status);
  return status === undefined ? new ChatGptError('invalid-response') : httpError(status);
}
export async function ensureOk(response: Response): Promise<void> {
  if (!response.ok) { const body = await json(response).catch(() => ({})); throw providerError(body, response.status); }
}

export type GenerationProgress = {
  phase: 'starting' | 'generating' | 'receiving';
  /** Observed assistant output text length in UTF-16 code units, never a token estimate. */
  outputChars: number;
  /** Reserved for observed provider usage; absent when no reliable count is available. */
  outputTokens?: number;
};

/** Deliberately returns only a completed text answer, never partial drafts or raw error bodies. */
export async function completedText(response: Response, secrets: string[], signal?: AbortSignal, onProgress?: (progress: GenerationProgress) => void): Promise<string> {
  if (!response.body) throw new ChatGptError('invalid-response');
  const reader = response.body.getReader(); const decoder = new TextDecoder('utf8', { fatal: true });
  let buffer = '', total = 0, result: string | undefined;
  // Some Responses streams put full content only in output_item.done, leaving the final
  // response.output empty. These are candidates, never successful output before completion.
  const completedItems = new Map<number, Record<string, unknown>>();
  const phases = new Map<number, string>();
  let completedChars = 0, observedChars = 0, progressPhase = -1, terminal = false;
  const observedParts = new Map<number, Map<number, { chars: number; deltaChars: number; tail: string }>>();
  const longestSecret = Math.max(0, ...secrets.map(secret => secret.length));
  function safeValue(value: unknown) {
    const pending = [value];
    while (pending.length) {
      const next = pending.pop();
      if (typeof next === 'string' && secrets.some(secret => secret && next.includes(secret))) throw new ChatGptError('invalid-response');
      if (record(next)) pending.push(...Object.values(next));
      else if (Array.isArray(next)) pending.push(...next);
    }
  }
  function progress(phase: GenerationProgress['phase']) {
    checkSignal(signal);
    if (terminal) return;
    const rank = ['starting', 'generating', 'receiving'].indexOf(phase);
    progressPhase = Math.max(progressPhase, rank);
    try { onProgress?.({ phase: ['starting', 'generating', 'receiving'][progressPhase] as GenerationProgress['phase'], outputChars: observedChars }); }
    catch { /* Observers cannot change provider acceptance or turn a draft into success. */ }
    checkSignal(signal);
  }
  function outputIndex(value: unknown): number {
    if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= 10_000) throw new ChatGptError('invalid-response');
    return value as number;
  }
  function observe(index: number, contentIndex: number, value: string, delta = false) {
    if (phases.get(index) === 'commentary') return;
    const parts = observedParts.get(index) ?? new Map(); observedParts.set(index, parts);
    const part = parts.get(contentIndex) ?? { chars: 0, deltaChars: 0, tail: '' };
    if (delta) {
      const joined = part.tail + value;
      safeValue(joined);
      part.tail = longestSecret ? joined.slice(-longestSecret) : '';
      part.deltaChars += value.length;
    }
    const chars = Math.max(part.chars, delta ? part.deltaChars : value.length);
    observedChars += chars - part.chars; part.chars = chars; parts.set(contentIndex, part);
    if (observedChars > 4 * 1024 * 1024) throw new ChatGptError('invalid-response');
  }
  function observeItem(item: unknown, index: number) {
    if (!record(item) || item.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content) || (item.phase ?? phases.get(index)) === 'commentary') return;
    item.content.forEach((part, contentIndex) => {
      if (record(part) && part.type === 'output_text' && typeof part.text === 'string') observe(index, contentIndex, part.text);
    });
  }
  function itemText(item: unknown, index: number): string[] {
    if (!record(item)) throw new ChatGptError('invalid-response');
    if (['function_call', 'custom_tool_call', 'mcp_call', 'web_search_call'].includes(String(item.type))) throw new ChatGptError('unsupported');
    if (item.type !== 'message' || item.role !== 'assistant') return [];
    if (item.status !== undefined && item.status !== 'completed') throw new ChatGptError('invalid-response');
    if (!Array.isArray(item.content)) throw new ChatGptError('invalid-response');
    const parts: string[] = [];
    for (const part of item.content) {
      if (!record(part) || part.type === 'refusal') throw new ChatGptError('invalid-response');
      if (part.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
    }
    return (item.phase ?? phases.get(index)) === 'commentary' ? [] : parts;
  }
  function event(raw: string) {
    checkSignal(signal);
    if (terminal) return;
    const data = raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    if (data.length > 2 * 1024 * 1024) throw new ChatGptError('invalid-response');
    if (secrets.some(s => s && data.includes(s))) throw new ChatGptError('invalid-response');
    const e: unknown = JSON.parse(data);
    if (!record(e)) throw new ChatGptError('invalid-response');
    safeValue(e);
    if (e.type === 'error' || e.type === 'response.failed' || e.type === 'response.incomplete') {
      const error = record(e.error) ? e.error : record(e.response) && record(e.response.error) ? e.response.error : undefined;
      throw providerError(error ?? e);
    }
    if (e.type === 'response.created' || e.type === 'response.in_progress') { progress('starting'); return; }
    if (e.type === 'response.output_text.delta') {
      const index = outputIndex(e.output_index), contentIndex = outputIndex(e.content_index ?? 0);
      if (typeof e.delta !== 'string') throw new ChatGptError('invalid-response');
      observe(index, contentIndex, e.delta, true); progress('receiving'); return;
    }
    if (e.type === 'response.output_item.added' || e.type === 'response.output_item.done') {
      const index = outputIndex(e.output_index);
      if (!record(e.item)) throw new ChatGptError('invalid-response');
      if (typeof e.item.phase === 'string') phases.set(index, e.item.phase);
      if (['function_call', 'custom_tool_call', 'mcp_call', 'web_search_call'].includes(String(e.item.type))) throw new ChatGptError('unsupported');
      if (e.type === 'response.output_item.done') {
        if (completedItems.has(index)) throw new ChatGptError('invalid-response');
        const parts = itemText(e.item, index);
        completedChars += parts.reduce((size, part) => size + part.length, 0);
        if (completedChars > 4 * 1024 * 1024) throw new ChatGptError('invalid-response');
        completedItems.set(index, e.item);
        observeItem(e.item, index);
        if (parts.length) progress('receiving');
      }
      if (e.item.type === 'reasoning') progress('generating');
      return;
    }
    if (typeof e.type === 'string' && e.type.startsWith('response.reasoning')) { progress('generating'); return; }
    if (e.type !== 'response.completed') return;
    if (!record(e.response) || e.response.status !== 'completed' || e.response.incomplete_details || (e.response.output != null && !Array.isArray(e.response.output))) throw new ChatGptError('invalid-response');
    // A populated terminal snapshot is authoritative; combining both representations duplicates
    // answers. For sparse snapshots, output_index (not arrival order) defines item order.
    const items: Array<[number, unknown]> = Array.isArray(e.response.output) && e.response.output.length
      ? e.response.output.map((item, index) => [index, item])
      : [...completedItems.entries()].sort(([left], [right]) => left - right);
    const parts = items.flatMap(([index, item]) => itemText(item, index));
    result = parts.join('\n');
    if (!result.trim() || result.length > 4 * 1024 * 1024 || secrets.some(secret => secret && result!.includes(secret))) throw new ChatGptError('invalid-response');
    for (const [index, item] of items) observeItem(item, index);
    progress('receiving'); terminal = true;
  }
  try {
    for (;;) {
      checkSignal(signal);
      const { done, value } = await reader.read();
      checkSignal(signal);
      if (done) { buffer += decoder.decode(); if (buffer.trim()) event(buffer); break; }
      total += value.byteLength; if (total > 16 * 1024 * 1024) throw new ChatGptError('invalid-response');
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      for (;;) { const end = buffer.indexOf('\n\n'); if (end < 0) break; event(buffer.slice(0, end)); buffer = buffer.slice(end + 2); }
      if (buffer.length > 2 * 1024 * 1024) throw new ChatGptError('invalid-response');
      if (result !== undefined) break;
    }
    checkSignal(signal); if (result === undefined) throw new ChatGptError('invalid-response'); return result;
  } catch (error) { checkSignal(signal); if (error instanceof ChatGptError) throw error; throw new ChatGptError('invalid-response'); }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
