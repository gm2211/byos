/** Node-only, independently implemented public SIWC protocol. No Codex or DevKit credentials/code. */
import { randomUUID } from 'node:crypto';
import { ChatGptError, checkSignal } from './errors.js';
import { keychainStore, processLock, type CredentialStore } from './storage.js';
import { authorize, discover, verifyIdentity } from './oauth.js';
import { RESOURCE, TOKEN, request, ensureOk, json, text, record, completedText } from './http.js';
export { ChatGptError, type ChatGptErrorCode } from './errors.js';
export type { CredentialStore } from './storage.js';
export type ChatGptAccount = { id: string; label: string; connected: boolean };
export type ChatGptStatus = { connected: boolean; planEnabled: boolean; account?: ChatGptAccount };
export type ChatGptModel = { id: string; name: string };
export type ChatGptClientOptions = {
  appName: string; namespace: string;
  /** Private directory for nonsecret inter-process lock files only; must agree across processes. */
  storageDirectory?: string;
  /** Receives a public authorization URL with no ID-token hint. Never log it. */
  openBrowser: (url: string) => void | Promise<void>;
  credentialStore?: CredentialStore; fetch?: typeof fetch; now?: () => number;
};
export interface ChatGptClient {
  status(): Promise<ChatGptStatus>;
  accounts(): Promise<ChatGptAccount[]>;
  selectAccount(id: string): Promise<ChatGptStatus>;
  /** Omit accountId to add a registration. Supply it to reconnect; enablePlan requests consent. */
  signIn(options?: { signal?: AbortSignal; accountId?: string; enablePlan?: boolean }): Promise<ChatGptStatus>;
  disconnect(): Promise<{ revoked: boolean }>;
  listModels(signal?: AbortSignal): Promise<ChatGptModel[]>;
  generate(request: { model: string; input: string; instructions?: string; signal?: AbortSignal }): Promise<{ text: string }>;
}
type Tokens = { access: string; refresh?: string; id?: string; expiresAt: number; scopes: string[]; earliestRefreshAt?: number };
type Registration = { id: string; label: string; clientId: string; subject?: string; tokens?: Tokens };
type State = { version: 1; revision: number; hostId: string; active?: string; registrations: Registration[] };
const terminalRefresh = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);
const planEnabled = (t?: Tokens) => !!t?.scopes.includes('chatgpt.tokens.use.direct') && t.scopes.includes('resource.invoke');
const safeAccount = (r: Registration): ChatGptAccount => ({ id: r.id, label: r.label, connected: !!r.tokens });
const stateStatus = (s: State): ChatGptStatus => {
  const r = s.registrations.find(r => r.id === s.active);
  return { connected: !!r?.tokens, planEnabled: planEnabled(r?.tokens), ...(r ? { account: safeAccount(r) } : {}) };
};
function parseState(raw: string | null): State {
  if (raw === null) return { version: 1, revision: 0, hostId: `urn:uuid:${randomUUID()}`, registrations: [] };
  try {
    if (raw.length > 1024 * 1024) throw new Error();
    const s: unknown = JSON.parse(raw);
    if (!record(s) || s.version !== 1 || !Number.isSafeInteger(s.revision) || Number(s.revision) < 0 || !text(s.hostId, 512) || !Array.isArray(s.registrations) || s.registrations.length > 100 || (s.active !== undefined && !text(s.active, 128))) throw new Error();
    const ids = new Set<string>(); const clients = new Set<string>();
    for (const r of s.registrations) {
      if (!record(r) || !text(r.id, 128) || !text(r.label, 320) || !text(r.clientId, 512) || ids.has(r.id) || clients.has(r.clientId) || (r.subject !== undefined && !text(r.subject, 512))) throw new Error();
      ids.add(r.id); clients.add(r.clientId);
      if (r.tokens !== undefined) {
        const t = r.tokens;
        if (!r.subject || !record(t) || !text(t.access) || (t.refresh !== undefined && !text(t.refresh)) || (t.id !== undefined && !text(t.id)) || typeof t.expiresAt !== 'number' || !Number.isFinite(t.expiresAt) || !Array.isArray(t.scopes) || !t.scopes.every(v => text(v, 128))) throw new Error();
      }
    }
    if (s.active !== undefined && !ids.has(s.active)) throw new Error();
    return s as unknown as State;
  } catch { throw new ChatGptError('storage-unavailable'); }
}
function tokensFrom(value: Record<string, unknown>, now: number, previous?: Tokens): Tokens {
  if (!text(value.access_token) || value.token_type !== 'Bearer' || typeof value.expires_in !== 'number' || !Number.isFinite(value.expires_in) || value.expires_in <= 0 || value.expires_in > 86_400 || (value.refresh_token !== undefined && !text(value.refresh_token)) || (value.id_token !== undefined && !text(value.id_token))) throw new ChatGptError('auth-failed');
  const scopes = typeof value.scope === 'string' ? value.scope.split(/\s+/).filter(Boolean) : previous?.scopes;
  if (!scopes || scopes.length > 100 || !scopes.every(s => text(s, 128))) throw new ChatGptError('auth-failed');
  // A rotating refresh must return its replacement. Never persist an already-spent grant.
  if (previous?.refresh && !text(value.refresh_token)) throw new ChatGptError('reconnect-required');
  return { access: value.access_token, ...(text(value.refresh_token) ? { refresh: value.refresh_token } : {}),
    ...(text(value.id_token) ? { id: value.id_token } : previous?.id ? { id: previous.id } : {}),
    expiresAt: now + value.expires_in * 1000, scopes,
    ...(typeof value.earliest_refresh_at === 'number' && Number.isFinite(value.earliest_refresh_at) ? { earliestRefreshAt: value.earliest_refresh_at } : {}),
  };
}
const activeRequests = new Map<string, Set<{ id?: string; controller: AbortController }>>();

export function createChatGptClient(options: ChatGptClientOptions): ChatGptClient {
  if (!text(options.appName, 100) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(options.namespace) || typeof options.openBrowser !== 'function') throw new TypeError('A valid appName, namespace and openBrowser are required.');
  const store = options.credentialStore ?? keychainStore(options.namespace);
  const locked = processLock(options.namespace, options.storageDirectory);
  const fetcher = options.fetch ?? globalThis.fetch, now = options.now ?? Date.now;
  const scope = options.namespace;
  let signingIn = false;
  async function load() { try { return parseState(await store.read()); } catch { throw new ChatGptError('storage-unavailable'); } }
  async function save(s: State) { try { await store.write(JSON.stringify(s)); } catch { throw new ChatGptError('storage-unavailable'); } }
  async function guarded<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    try { return await run(); } catch (e) { checkSignal(signal); if (e instanceof ChatGptError) throw e; throw new ChatGptError('unavailable'); }
  }
  function operation(id?: string, parent?: AbortSignal) {
    const controller = new AbortController(); const entry = { id, controller };
    const set = activeRequests.get(scope) ?? new Set(); activeRequests.set(scope, set); set.add(entry);
    return { controller, signal: AbortSignal.any([controller.signal, ...(parent ? [parent] : [])]), done() { set.delete(entry); if (!set.size) activeRequests.delete(scope); } };
  }
  function stop(id?: string, except?: AbortController) { for (const e of activeRequests.get(scope) ?? []) if (e.id && e.id === id && e.controller !== except) e.controller.abort(); }
  async function exchange(body: URLSearchParams, signal?: AbortSignal) {
    return request(fetcher, TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() }, signal);
  }
  async function currentConnection(): Promise<{ id: string; revision: number }> {
    const s = await locked(load); if (!s.active) throw new ChatGptError('reconnect-required'); return { id: s.active, revision: s.revision };
  }
  async function credential(id: string, signal?: AbortSignal): Promise<Tokens> {
    return locked(async () => {
      const s = await load(), r = s.registrations.find(r => r.id === id);
      if (!r?.tokens) throw new ChatGptError('reconnect-required');
      if (!planEnabled(r.tokens)) throw new ChatGptError('consent-required');
      if (r.tokens.expiresAt > now() + 60_000) return { ...r.tokens };
      if (!r.tokens.refresh) throw new ChatGptError('reconnect-required');
      // Finish and commit a rotating grant even when one caller cancels; disconnect waits for this lock.
      const response = await exchange(new URLSearchParams({ grant_type: 'refresh_token', client_id: r.clientId, refresh_token: r.tokens.refresh, resource: RESOURCE }));
      if (!response.ok) {
        const body: Record<string, unknown> = await json(response).catch(() => ({}));
        if (terminalRefresh.has(String(body.error ?? ''))) { delete r.tokens; await save(s); throw new ChatGptError('reconnect-required', response.status); }
        throw new ChatGptError('unavailable', response.status);
      }
      let next: Tokens;
      try {
        const body = await json(response);
        next = tokensFrom(body, now(), r.tokens);
        if (text(body.id_token)) {
          const identity = await verifyIdentity(fetcher, body.id_token, r.clientId, undefined, now());
          if (identity.subject !== r.subject) throw new ChatGptError('auth-failed');
        }
      } catch {
        // A successful exchange may have consumed the old grant even if its response is malformed.
        delete r.tokens; await save(s); throw new ChatGptError('reconnect-required');
      }
      r.tokens = next; await save(s); checkSignal(signal);
      if (!planEnabled(next)) throw new ChatGptError('consent-required'); return { ...next };
    }, signal);
  }
  async function provider<T>(run: (tokens: Tokens, signal: AbortSignal) => Promise<T>, caller?: AbortSignal): Promise<T> {
    checkSignal(caller);
    const connection = await currentConnection(), { id, revision } = connection, op = operation(id, caller);
    try { return await guarded(async () => {
      const t = await credential(id, op.signal); checkSignal(op.signal);
      await locked(async () => { if ((await load()).revision !== revision) throw new ChatGptError('canceled'); }, op.signal);
      const value = await run(t, op.signal); checkSignal(op.signal);
      await locked(async () => { const s = await load(); if (s.revision !== revision || s.active !== id || !s.registrations.find(r => r.id === id)?.tokens) throw new ChatGptError('canceled'); }, op.signal);
      return value;
    }, op.signal); }
    finally { op.done(); }
  }
  const client: ChatGptClient = {
    status: () => guarded(() => locked(async () => stateStatus(await load()))),
    accounts: () => guarded(() => locked(async () => (await load()).registrations.map(safeAccount))),
    selectAccount: id => guarded(() => locked(async () => {
      const s = await load(); if (!s.registrations.some(r => r.id === id)) throw new ChatGptError('reconnect-required');
      stop(s.active); s.active = id; s.revision++; await save(s); return stateStatus(s);
    })),
    async signIn(input = {}) {
      if (signingIn) throw new ChatGptError('busy'); signingIn = true;
      const op = operation(input.accountId, input.signal);
      try { return await guarded(async () => {
        const pending = await locked(async () => {
          const s = await load();
          const r = input.accountId ? s.registrations.find(r => r.id === input.accountId) : undefined;
          if (input.accountId && !r) throw new ChatGptError('reconnect-required');
          await save(s); return { hostId: s.hostId, revision: s.revision, registration: r ? { ...r } : undefined };
        }, op.signal);
        const auth = await authorize({ appName: options.appName, hostId: pending.hostId, clientId: pending.registration?.clientId, enablePlan: input.enablePlan, openBrowser: options.openBrowser, signal: op.signal });
        // Retain the issued client even if a code exchange fails, so retries need not register again.
        const id = await locked(async () => {
          checkSignal(op.signal); const s = await load();
          if (s.revision !== pending.revision) throw new ChatGptError('canceled');
          const existing = s.registrations.find(r => r.clientId === auth.clientId);
          if (pending.registration && existing?.id !== pending.registration.id) throw new ChatGptError('auth-failed');
          if (existing) return existing.id;
          if (s.registrations.length >= 100) throw new ChatGptError('unsupported');
          const id = randomUUID(); s.registrations.push({ id, label: `ChatGPT ${id.slice(0, 8)}`, clientId: auth.clientId }); await save(s); return id;
        }, op.signal);
        const response = await exchange(new URLSearchParams({ grant_type: 'authorization_code', client_id: auth.clientId, code: auth.code, code_verifier: auth.verifier, redirect_uri: auth.redirectUri, resource: RESOURCE }), op.signal);
        if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new ChatGptError('auth-failed', response.status); }
        const body = await json(response), tokens = tokensFrom(body, now());
        if (!tokens.id) throw new ChatGptError('auth-failed');
        const identity = await verifyIdentity(fetcher, tokens.id, auth.clientId, auth.nonce, now(), op.signal);
        return locked(async () => {
          checkSignal(op.signal); const s = await load();
          if (s.revision !== pending.revision) throw new ChatGptError('canceled');
          const r = s.registrations.find(r => r.id === id);
          if (!r || r.clientId !== auth.clientId || (r.subject && r.subject !== identity.subject)) throw new ChatGptError('auth-failed');
          r.subject = identity.subject; r.label = `${identity.email ?? 'ChatGPT'} · ${r.id.slice(0, 8)}`; r.tokens = tokens;
          stop(s.active, op.controller); s.active = id; s.revision++; await save(s); return stateStatus(s);
        }, op.signal);
      }, op.signal); } finally { signingIn = false; op.done(); }
    },
    async disconnect() {
      // Cancel pending sign-in immediately, including one waiting for the rotating-refresh lock.
      for (const e of activeRequests.get(scope) ?? []) e.controller.abort();
      return guarded(() => locked(async () => {
        const s = await load(), r = s.registrations.find(r => r.id === s.active);
        s.revision++;
        if (!r?.tokens) { await save(s); return { revoked: true }; }
        let revoked = !r.tokens.refresh;
        try {
          if (r.tokens.refresh) {
            const metadata = await discover(fetcher);
            const response = await request(fetcher, metadata.revocation, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: r.tokens.refresh, token_type_hint: 'refresh_token', client_id: r.clientId }).toString() });
            revoked = response.status === 200; await response.body?.cancel().catch(() => {});
          }
        } catch { revoked = false; }
        delete r.tokens; await save(s); return { revoked };
      }));
    },
    listModels: signal => provider(async (t, signal) => {
      const response = await request(fetcher, `${RESOURCE}/models`, { headers: { Authorization: `Bearer ${t.access}`, Accept: 'application/json' } }, signal); await ensureOk(response);
      const body = await json(response); if (!Array.isArray(body.models)) throw new ChatGptError('invalid-response');
      const seen = new Set<string>(); const models: ChatGptModel[] = [];
      for (const m of body.models) {
        if (!record(m) || !text(m.slug, 128) || /\s/.test(m.slug) || m.visibility !== 'list' || seen.has(m.slug)) continue;
        models.push({ id: m.slug, name: text(m.display_name, 256) ? m.display_name : m.slug }); seen.add(m.slug);
      }
      if (!models.length) throw new ChatGptError('unsupported'); return models;
    }, signal),
    generate: input => provider(async (t, signal) => {
      if (!text(input.model, 128) || /\s/.test(input.model) || typeof input.input !== 'string' || !input.input.trim() || input.input.length > 1_000_000 || (input.instructions !== undefined && (typeof input.instructions !== 'string' || input.instructions.length > 1_000_000))) throw new ChatGptError('unsupported');
      const response = await request(fetcher, `${RESOURCE}/responses`, { method: 'POST', headers: { Authorization: `Bearer ${t.access}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify({ model: input.model, input: [{ role: 'user', content: [{ type: 'input_text', text: input.input }] }], ...(input.instructions ? { instructions: input.instructions } : {}), store: false, stream: true }) }, signal, 10 * 60_000);
      await ensureOk(response);
      const result = await completedText(response, [t.access, t.refresh ?? '', t.id ?? ''], signal);
      return { text: result };
    }, input.signal),
  };
  return client;
}
