/** Node-only Claude Pro/Max subscription client: OAuth (loopback + paste), Keychain tokens, direct HTTPS. */
import { ClaudeError, checkSignal, httpError } from './errors.js';
import { keychainStore, processLock, type CredentialStore } from './storage.js';
import { CLIENT_ID, TOKEN_URL, PASTE_REDIRECT_URI, loopbackAuthorize, newPkce, authorizeUrl, parsePastedCode, type Pkce } from './oauth.js';
export { ClaudeError, type ClaudeErrorCode } from './errors.js';
export type { CredentialStore } from './storage.js';
export { CLIENT_ID, AUTHORIZE_URL, TOKEN_URL, SCOPE, LOOPBACK_PORT, PASTE_REDIRECT_URI } from './oauth.js';

export const API = 'https://api.anthropic.com/v1';
export const ANTHROPIC_VERSION = '2023-06-01';
/** Beta flags a subscription Bearer token needs. */
export const BETA_HEADER = 'oauth-2025-04-20,claude-code-20250219';
/** Subscription tokens are only honored for requests that open with this system block. */
export const SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";
const THINKING_MAX_TOKENS_FLOOR = 4096;

export type ClaudeAccount = { label: string };
export type ClaudeStatus = { connected: boolean; account?: ClaudeAccount };
export type ClaudeModel = { id: string; name: string };
export type ClaudeClientOptions = {
  appName: string; namespace: string;
  /** Private directory for nonsecret inter-process lock files only. */
  storageDirectory?: string;
  /** Receives the public authorization URL. */
  openBrowser: (url: string) => void | Promise<void>;
  credentialStore?: CredentialStore; fetch?: typeof fetch; now?: () => number;
  /** Loopback callback port. Claude's client only accepts the default, 54134; override in tests. */
  loopbackPort?: number;
};
export interface ClaudeClient {
  status(): Promise<ClaudeStatus>;
  /** Loopback sign-in: opens the browser, waits for the redirect. Fails with `port-in-use` when the port is taken. */
  signIn(options?: { signal?: AbortSignal }): Promise<ClaudeStatus>;
  /** Paste fallback, step 1: returns the URL to open. The console page then shows a `CODE#STATE` string. */
  beginPasteSignIn(): { url: string };
  /** Paste fallback, step 2. */
  completePasteSignIn(pasted: string, signal?: AbortSignal): Promise<ClaudeStatus>;
  disconnect(): Promise<void>;
  listModels(signal?: AbortSignal): Promise<ClaudeModel[]>;
  generate(request: { model: string; input: string; instructions?: string; maxTokens?: number; signal?: AbortSignal; onText?: (delta: string) => void }): Promise<{ text: string }>;
}
type Tokens = { access: string; refresh?: string; expiresAt: number; label?: string };
type State = { version: 1; tokens?: Tokens };

const str = (x: unknown, max = 32_768): x is string => typeof x === 'string' && x.length > 0 && x.length <= max && !/[\u0000-\u001f\u007f]/.test(x);
const rec = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

function parseState(raw: string | null): State {
  if (raw === null) return { version: 1 };
  try {
    const s: unknown = JSON.parse(raw);
    if (!rec(s) || s.version !== 1) throw new Error();
    const t = s.tokens;
    if (t !== undefined && (!rec(t) || !str(t.access) || (t.refresh !== undefined && !str(t.refresh)) || typeof t.expiresAt !== 'number' || !Number.isFinite(t.expiresAt) || (t.label !== undefined && !str(t.label, 320)))) throw new Error();
    return s as State;
  } catch { throw new ClaudeError('storage-unavailable'); }
}
/** 5-series models think by default and take `output_config.effort`; older ones think only when asked. */
export function thinksByDefault(model: string): boolean {
  const parts = model.toLowerCase().split('-'); if (parts.shift() !== 'claude') return false;
  if (parts[0] && !/^\d+$/.test(parts[0])) parts.shift();
  return /^\d+$/.test(parts[0] ?? '') && Number(parts[0]) >= 5;
}
async function body(response: Response): Promise<Record<string, unknown>> {
  try { const v: unknown = await response.json(); if (!rec(v)) throw new Error(); return v; } catch { throw new ClaudeError('invalid-response'); }
}

export function createClaudeClient(options: ClaudeClientOptions): ClaudeClient {
  if (!str(options.appName, 100) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(options.namespace) || typeof options.openBrowser !== 'function') throw new TypeError('A valid appName, namespace and openBrowser are required.');
  const store = options.credentialStore ?? keychainStore(options.namespace);
  const locked = processLock(options.namespace, options.storageDirectory);
  const fetcher = options.fetch ?? globalThis.fetch, now = options.now ?? Date.now;
  let signingIn = false, paste: Pkce | undefined;
  const load = async () => { try { return parseState(await store.read()); } catch { throw new ClaudeError('storage-unavailable'); } };
  const save = async (s: State) => { try { await store.write(JSON.stringify(s)); } catch { throw new ClaudeError('storage-unavailable'); } };
  const statusOf = (s: State): ClaudeStatus => s.tokens ? { connected: true, account: { label: s.tokens.label ?? 'Claude subscription' } } : { connected: false };
  async function call(url: string, init: RequestInit, signal?: AbortSignal, timeoutMs = 30_000): Promise<Response> {
    checkSignal(signal);
    try { return await fetcher(url, { ...init, redirect: 'error', credentials: 'omit', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]) }); }
    catch { checkSignal(signal); throw new ClaudeError('unavailable'); }
  }
  const token = (payload: Record<string, unknown>, previous?: Tokens): Tokens => {
    if (!str(payload.access_token) || (payload.refresh_token !== undefined && !str(payload.refresh_token))) throw new ClaudeError('auth-failed');
    const expiresIn = typeof payload.expires_in === 'number' && payload.expires_in > 0 ? payload.expires_in : 8 * 3600;
    const email = rec(payload.account) && str(payload.account.email_address, 256) ? payload.account.email_address : undefined;
    const label = email ?? previous?.label;
    return { access: payload.access_token, refresh: str(payload.refresh_token) ? payload.refresh_token : previous?.refresh, expiresAt: now() + expiresIn * 1000, ...(label ? { label } : {}) };
  };
  async function exchange(code: string, pkce: Pkce, signal?: AbortSignal): Promise<ClaudeStatus> {
    const response = await call(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', code, state: pkce.state, client_id: CLIENT_ID, redirect_uri: pkce.redirectUri, code_verifier: pkce.verifier }) }, signal);
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new ClaudeError('auth-failed', response.status); }
    const tokens = token(await body(response));
    return locked(async () => { const s: State = { version: 1, tokens }; await save(s); return statusOf(s); }, signal);
  }
  async function credential(signal?: AbortSignal): Promise<string> {
    return locked(async () => {
      const s = await load(), t = s.tokens;
      if (!t) throw new ClaudeError('reconnect-required');
      if (t.expiresAt > now() + 60_000) return t.access;
      if (!t.refresh) { delete s.tokens; await save(s); throw new ClaudeError('reconnect-required'); }
      const response = await call(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: CLIENT_ID }) });
      if (response.status === 400 || response.status === 401) { await response.body?.cancel().catch(() => {}); delete s.tokens; await save(s); throw new ClaudeError('reconnect-required', response.status); }
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new ClaudeError('unavailable', response.status); }
      // The refresh token rotates: persist the replacement even if this caller cancels meanwhile.
      s.tokens = token(await body(response), t); await save(s); checkSignal(signal);
      return s.tokens.access;
    }, signal);
  }
  const headers = (access: string, json: boolean): Record<string, string> => ({
    Authorization: `Bearer ${access}`, 'anthropic-version': ANTHROPIC_VERSION, 'anthropic-beta': BETA_HEADER, ...(json ? { 'Content-Type': 'application/json' } : {}),
  });
  async function guarded<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    try { return await run(); } catch (e) { checkSignal(signal); if (e instanceof ClaudeError) throw e; throw new ClaudeError('unavailable'); }
  }

  return {
    status: () => guarded(() => locked(async () => statusOf(await load()))),
    async signIn(input = {}) {
      if (signingIn) throw new ClaudeError('busy'); signingIn = true;
      try { return await guarded(async () => {
        const { code, pkce } = await loopbackAuthorize({ openBrowser: options.openBrowser, signal: input.signal, port: options.loopbackPort });
        return exchange(code, pkce, input.signal);
      }, input.signal); } finally { signingIn = false; }
    },
    beginPasteSignIn() { paste = newPkce(PASTE_REDIRECT_URI); return { url: authorizeUrl(paste) }; },
    async completePasteSignIn(pasted, signal) {
      const pkce = paste; if (!pkce) throw new ClaudeError('auth-failed');
      return guarded(async () => { const status = await exchange(parsePastedCode(pasted, pkce), pkce, signal); paste = undefined; return status; }, signal);
    },
    disconnect: () => guarded(() => locked(async () => { await save({ version: 1 }); })),
    listModels: signal => guarded(async () => {
      const access = await credential(signal), models: ClaudeModel[] = [];
      let after = '';
      for (let page = 0; page < 5; page++) {
        const response = await call(`${API}/models?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ''}`, { headers: headers(access, false) }, signal);
        if (!response.ok) { await response.body?.cancel().catch(() => {}); throw httpError(response.status); }
        const payload = await body(response);
        if (!Array.isArray(payload.data)) throw new ClaudeError('invalid-response');
        for (const m of payload.data) if (rec(m) && str(m.id, 128) && !/\s/.test(m.id)) models.push({ id: m.id, name: str(m.display_name, 256) ? m.display_name : m.id });
        if (payload.has_more !== true || !str(payload.last_id)) break;
        after = payload.last_id;
      }
      if (!models.length) throw new ClaudeError('unsupported'); return models;
    }, signal),
    generate: input => guarded(async () => {
      if (!str(input.model, 128) || /\s/.test(input.model) || typeof input.input !== 'string' || !input.input.trim() || input.input.length > 1_000_000 || (input.instructions !== undefined && (typeof input.instructions !== 'string' || input.instructions.length > 1_000_000))) throw new ClaudeError('unsupported');
      const access = await credential(input.signal);
      const think = thinksByDefault(input.model);
      const maxTokens = input.maxTokens && input.maxTokens > 0 ? input.maxTokens : 2048;
      const response = await call(`${API}/messages`, { method: 'POST', headers: headers(access, true), body: JSON.stringify({
        model: input.model, stream: true,
        // Thinking counts against max_tokens; low effort plus a floor leaves room to answer.
        max_tokens: think ? Math.max(maxTokens, THINKING_MAX_TOKENS_FLOOR) : maxTokens,
        system: [{ type: 'text', text: SYSTEM_PREFIX }, ...(input.instructions ? [{ type: 'text', text: input.instructions }] : [])],
        messages: [{ role: 'user', content: input.input }],
        ...(think ? { output_config: { effort: 'low' } } : {}),
      }) }, input.signal, 10 * 60_000);
      if (!response.ok || !response.body) { await response.body?.cancel().catch(() => {}); throw httpError(response.status); }
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '', text = '', ended = false;
      const line = (raw: string) => {
        const l = raw.trim(); if (!l.startsWith('data:')) return;
        let data: { type?: string; delta?: { type?: string; text?: unknown } };
        try { data = JSON.parse(l.slice(5)); } catch { return; }
        if (data.type === 'error') throw new ClaudeError('unavailable');
        if (data.type === 'message_stop') ended = true;
        if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta' && typeof data.delta.text === 'string') { text += data.delta.text; input.onText?.(data.delta.text); }
      };
      try {
        for (;;) {
          checkSignal(input.signal);
          const { value, done } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? '';
          lines.forEach(line);
          if (done) { line(buffer); break; }
        }
      } finally { await reader.cancel().catch(() => {}); }
      if (!ended || !text.trim()) throw new ClaudeError('invalid-response');
      return { text };
    }, input.signal),
  };
}
