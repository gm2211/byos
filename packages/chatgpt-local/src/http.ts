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

/** Deliberately returns only a completed text answer, never partial drafts or raw error bodies. */
export async function completedText(response: Response, secrets: string[], signal?: AbortSignal): Promise<string> {
  if (!response.body) throw new ChatGptError('invalid-response');
  const reader = response.body.getReader(); const decoder = new TextDecoder('utf8', { fatal: true });
  let buffer = '', total = 0, result: string | undefined;
  function event(raw: string) {
    const data = raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    if (secrets.some(s => s && data.includes(s))) throw new ChatGptError('invalid-response');
    const e: unknown = JSON.parse(data);
    if (!record(e)) throw new ChatGptError('invalid-response');
    if (e.type === 'error' || e.type === 'response.failed' || e.type === 'response.incomplete') {
      const error = record(e.error) ? e.error : record(e.response) && record(e.response.error) ? e.response.error : undefined;
      throw providerError(error ?? e);
    }
    if (e.type !== 'response.completed') return;
    if (!record(e.response) || e.response.status !== 'completed' || e.response.incomplete_details || !Array.isArray(e.response.output)) throw new ChatGptError('invalid-response');
    const parts: string[] = [];
    for (const item of e.response.output) {
      if (!record(item)) throw new ChatGptError('invalid-response');
      if (['function_call', 'custom_tool_call', 'mcp_call', 'web_search_call'].includes(String(item.type))) throw new ChatGptError('unsupported');
      if (item.type !== 'message' || item.role !== 'assistant' || item.phase === 'commentary') continue;
      if (!Array.isArray(item.content)) throw new ChatGptError('invalid-response');
      for (const part of item.content) {
        if (!record(part) || part.type === 'refusal') throw new ChatGptError('invalid-response');
        if (part.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
      }
    }
    result = parts.join('\n');
    if (!result.trim() || result.length > 4 * 1024 * 1024 || secrets.some(secret => secret && result!.includes(secret))) throw new ChatGptError('invalid-response');
  }
  try {
    for (;;) {
      checkSignal(signal);
      const { done, value } = await reader.read();
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
