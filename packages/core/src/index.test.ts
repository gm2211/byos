import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
// Built output: the sources use NodeNext `.js` imports (see shared/ai-protocol/src/index.test.ts).
import * as core from '../dist/index.js';
import { createCredentialVault, createEffortStore, createModelCatalogCache, pickerModels, tokenNeedsRefresh } from '../dist/index.js';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  failWrites = false;
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.has(key) ? this.data.get(key)! : null; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  removeItem(key: string) { this.data.delete(key); }
  setItem(key: string, value: string) { if (this.failWrites) throw new Error('quota'); this.data.set(key, String(value)); }
}

const areas = () => ({ session: new MemoryStorage(), local: new MemoryStorage() });

test('vault keeps Motive-compatible keys and separates sites by prefix', () => {
  const storage = areas();
  const motive = createCredentialVault({ prefix: 'motive-ai-credential:', storage });
  const other = createCredentialVault({ prefix: 'garden-ai-credential:', storage });
  motive.store('xai-oauth', ' tok ', 'browser');
  assert.equal(storage.local.getItem('motive-ai-credential:xai-oauth'), 'tok');
  assert.equal(motive.read('xai-oauth'), 'tok');
  assert.equal(motive.persistence('xai-oauth'), 'browser');
  assert.equal(other.read('xai-oauth'), '');
});

test('storage-backed helpers reject unscoped prefixes', () => {
  assert.throws(() => createCredentialVault({ prefix: '', storage: areas() }), /Storage prefix/);
  assert.throws(() => createEffortStore({ prefix: ' ', storage: areas() }), /Storage prefix/);
  assert.throws(() => createModelCatalogCache({ prefix: 'x'.repeat(129), storage: areas() }), /Storage prefix/);
});

test('session-only sign-in works when localStorage is unavailable', () => {
  const session = new MemoryStorage();
  const vault = createCredentialVault({ prefix: 'session-only:', storage: { session } });
  vault.store('provider', 'token', 'session');
  vault.storeRefresh('provider', { refreshToken: 'refresh' }, 'session');
  assert.equal(vault.read('provider'), 'token');
  assert.equal(vault.persistence('provider'), 'session');
  assert.deepEqual(vault.readRefresh('provider'), { refreshToken: 'refresh', expiresAt: undefined });
  vault.setPersistence('provider', 'session');
  assert.throws(() => vault.store('provider', 'token', 'browser'), /storage is unavailable/);
  vault.clear('provider');
  assert.equal(vault.read('provider'), '');
  assert.equal(vault.readRefresh('provider'), null);
});

test('clearing a sign-in also forgets its refresh grant', () => {
  const vault = createCredentialVault({ prefix: 'p:', storage: areas() });
  vault.store('codex', 'a', 'session');
  vault.storeRefresh('codex', { refreshToken: 'r', expiresAt: 5 }, 'session');
  assert.deepEqual(vault.readRefresh('codex'), { refreshToken: 'r', expiresAt: 5 });
  vault.clear('codex');
  assert.equal(vault.read('codex'), '');
  assert.equal(vault.readRefresh('codex'), null);
});

test('replacing a sign-in removes its previous refresh grant and preserves old state on write failure', () => {
  const storage = areas();
  const vault = createCredentialVault({ prefix: 'p:', storage });
  vault.store('codex', 'old-account', 'session');
  vault.storeRefresh('codex', { refreshToken: 'old-refresh', expiresAt: 1 }, 'session');

  storage.local.failWrites = true;
  assert.throws(() => vault.store('codex', 'new-account', 'browser'), /quota/);
  assert.equal(vault.read('codex'), 'old-account');
  assert.deepEqual(vault.readRefresh('codex'), { refreshToken: 'old-refresh', expiresAt: 1 });

  storage.local.failWrites = false;
  vault.store('codex', 'new-account', 'browser');
  assert.equal(vault.read('codex'), 'new-account');
  assert.equal(vault.readRefresh('codex'), null);
  assert.equal(storage.session.getItem('p:codex'), null);
});

test('moving persistence carries the grant and rolls back when storage refuses', () => {
  const storage = areas();
  const vault = createCredentialVault({ prefix: 'p:', storage });
  vault.store('codex', 'a', 'session');
  vault.storeRefresh('codex', { refreshToken: 'r' }, 'session');
  vault.setPersistence('codex', 'browser');
  assert.equal(storage.local.getItem('p:codex'), 'a');
  assert.equal(storage.session.getItem('p:codex'), null);
  assert.ok(storage.local.getItem('p:codex:refresh'));

  storage.session.failWrites = true;
  assert.throws(() => vault.setPersistence('codex', 'session'));
  assert.equal(vault.read('codex'), 'a');
  assert.equal(vault.persistence('codex'), 'browser');
});

test('effort: saved choice only while supported, then recommendation, then provider default', () => {
  const store = createEffortStore({ prefix: 'e:', storage: areas(), recommend: (p, m) => (p === 'codex' && m === 'luna' ? 'max' : undefined) });
  const luna = { id: 'luna', reasoningEfforts: [{ effort: 'low' as const }, { effort: 'max' as const }], defaultReasoningEffort: 'low' as const };
  assert.equal(store.resolve('codex', luna), 'max');
  assert.equal(store.resolve('other', luna), 'low');
  store.store('codex', 'luna', 'low');
  assert.equal(store.resolve('codex', luna), 'low');
  store.store('codex', 'luna', 'ultra');
  assert.equal(store.resolve('codex', luna), 'max');
  assert.equal(store.resolve('codex', { id: 'x' }), '');
});

test('model cache drops junk ids and a stale list keeps the user selection', () => {
  const storage = areas();
  const cache = createModelCatalogCache({ prefix: 'm:', storage });
  assert.equal(cache.read('xai'), undefined);
  cache.store('xai', [{ id: 'grok-4', name: 'Grok 4' }]);
  storage.local.setItem('m:bad', JSON.stringify([{ id: 'has space' }, { id: 'ok' }]));
  assert.deepEqual(cache.read('xai'), [{ id: 'grok-4', name: 'Grok 4' }]);
  assert.deepEqual(cache.read('bad'), [{ id: 'ok', name: 'ok' }]);
  const models = [{ id: 'a', name: 'A' }];
  assert.deepEqual(pickerModels(models, 'gone', true), models);
  assert.deepEqual(pickerModels(models, 'kept', false).map(m => m.id), ['a', 'kept']);
});

test('refresh window matches the providers', () => {
  assert.equal(tokenNeedsRefresh(undefined, 1000, 0), false);
  assert.equal(tokenNeedsRefresh(1500, 1000, 600), true);
  assert.equal(tokenNeedsRefresh(5000, 1000, 600), false);
});

test('Claude OAuth helpers: authorize URL, pasted code, token bodies and the strict request allowlist', async () => {
  const core = await import('../dist/index.js');
  const url = new URL(core.claudeAuthorizeUrl({ challenge: 'c'.repeat(43), state: 's'.repeat(43), redirectUri: core.CLAUDE_PASTE_REDIRECT_URI }));
  assert.equal(`${url.origin}${url.pathname}`, 'https://claude.com/cai/oauth/authorize');
  assert.equal(url.searchParams.get('code'), 'true');
  assert.equal(url.searchParams.get('client_id'), core.CLAUDE_OAUTH_CLIENT_ID);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'user:profile user:inference');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://platform.claude.com/oauth/code/callback');

  assert.equal(core.parseClaudePastedCode(' abc#STATE ', 'STATE'), 'abc');
  assert.equal(core.parseClaudePastedCode('abc', 'STATE'), 'abc');
  assert.equal(core.parseClaudePastedCode('abc#OTHER', 'STATE'), undefined);
  assert.equal(core.parseClaudePastedCode('a b#STATE', 'STATE'), undefined);
  assert.equal(core.parseClaudePastedCode('', 'STATE'), undefined);
  assert.equal(core.parseClaudePastedCode('x'.repeat(4097), 'STATE'), undefined);

  const verifier = 'v'.repeat(43), state = 's'.repeat(43);
  const exchange = core.buildClaudeTokenRequest({ kind: 'authorization_code', code: 'code-1', state, verifier, redirectUri: core.CLAUDE_PASTE_REDIRECT_URI });
  assert.deepEqual(exchange, { grant_type: 'authorization_code', code: 'code-1', state, client_id: core.CLAUDE_OAUTH_CLIENT_ID, redirect_uri: core.CLAUDE_PASTE_REDIRECT_URI, code_verifier: verifier });
  const refresh = core.buildClaudeTokenRequest({ kind: 'refresh_token', refreshToken: 'rt-1' });
  assert.deepEqual(refresh, { grant_type: 'refresh_token', refresh_token: 'rt-1', client_id: core.CLAUDE_OAUTH_CLIENT_ID });
  assert.deepEqual(core.validateClaudeTokenRequest(exchange), exchange);
  assert.deepEqual(core.validateClaudeTokenRequest(refresh), refresh);

  const bad: unknown[] = [
    null, [], 'x', {}, { ...exchange, extra: 1 }, { ...refresh, extra: 1 },
    { ...exchange, client_id: 'other' }, { ...refresh, client_id: 'other' },
    { ...exchange, redirect_uri: 'https://evil.example/cb' },
    { ...exchange, grant_type: 'password' },
    { ...exchange, code: '' }, { ...exchange, code: 'a b' }, { ...exchange, code: 'x'.repeat(4097) }, { ...exchange, code: 5 },
    { ...exchange, state: 'short' }, { ...exchange, state: `${'s'.repeat(42)}!` }, { ...exchange, code_verifier: 'v'.repeat(129) },
    { ...refresh, refresh_token: '' }, { ...refresh, refresh_token: 'a\nb' }, { ...refresh, refresh_token: ['x'] },
    { grant_type: 'refresh_token', client_id: core.CLAUDE_OAUTH_CLIENT_ID, refresh_token: 'x', code: 'y' },
  ];
  for (const value of bad) assert.equal(core.validateClaudeTokenRequest(value), undefined, JSON.stringify(value));

  assert.deepEqual(core.filterClaudeTokenResponse({
    access_token: 'at', refresh_token: 'rt', expires_in: 3600, token_type: 'Bearer', scope: 'user:inference',
    account: { email_address: 'a@b.example', uuid: 'secret' }, organization: { uuid: 'x' }, extra: 1,
  }), { access_token: 'at', refresh_token: 'rt', expires_in: 3600, token_type: 'Bearer', scope: 'user:inference', account: { email_address: 'a@b.example' } });
  assert.deepEqual(core.filterClaudeTokenResponse({ access_token: 'at', expires_in: -1 }), { access_token: 'at' });
  assert.equal(core.filterClaudeTokenResponse({ refresh_token: 'rt' }), undefined);
  assert.equal(core.filterClaudeTokenResponse('nope'), undefined);
});

test('createCredentialRefresher runs one refresh for parallel callers and never overwrites a newer credential', async () => {
  const { createCredentialRefresher } = await import('../dist/index.js');
  let stored: string | null = 'v1';
  const make = () => createCredentialRefresher({
    lockName: 'test-lock', readCredential: () => stored, saveCredential: value => { stored = value; }, reconnectError: () => new Error('reconnect'),
  });
  let runs = 0;
  const slow = async () => { runs++; await new Promise(resolve => setTimeout(resolve, 10)); return 'v2'; };
  const refresher = make();
  const results = await Promise.all([refresher.refreshed('v1', slow), refresher.refreshed('v1', slow), refresher.refreshed('v1', slow)]);
  assert.deepEqual(results, ['v2', 'v2', 'v2']);
  assert.equal(runs, 1);
  assert.equal(stored, 'v2');

  // A newer credential saved elsewhere (another tab) wins, and the refresh is not attempted.
  stored = 'v9';
  runs = 0;
  assert.equal(await make().refreshed('v2', slow), 'v9');
  assert.equal(runs, 0);

  // Reconnect during the refresh: the rotated grant is not saved over the newer choice.
  stored = 'v2';
  assert.equal(await make().refreshed('v2', async () => { stored = 'v7'; return 'v3'; }), 'v7');
  assert.equal(stored, 'v7');
  // Disconnect during the refresh surfaces the reconnect error.
  stored = 'v2';
  await assert.rejects(() => make().refreshed('v2', async () => { stored = null; return 'v3'; }), /reconnect/);
  assert.equal(stored, null);

  // A caller that aborts stops waiting; the refresh still finishes and is saved.
  stored = 'v2';
  const controller = new AbortController();
  const waiting = make().refreshed('v2', async () => { await new Promise(resolve => setTimeout(resolve, 10)); return 'v5'; }, controller.signal);
  controller.abort();
  await assert.rejects(waiting);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(stored, 'v5');
});

const xaiVectors = JSON.parse(readFileSync(new URL('../conformance/xai-oauth.json', import.meta.url), 'utf8'));
const decodedPairs = (body: string) => [...new URLSearchParams(body).entries()];

test('xAI OAuth constants and headers match the conformance vectors', () => {
  const c = xaiVectors.constants;
  assert.equal(core.XAI_OAUTH_CLIENT_ID, c.clientId);
  assert.equal(core.XAI_DEVICE_CODE_URL, c.deviceCodeUrl);
  assert.equal(core.XAI_TOKEN_URL, c.tokenUrl);
  assert.equal(core.XAI_OAUTH_SCOPE, c.scope);
  assert.equal(core.XAI_DEVICE_CODE_GRANT, c.deviceCodeGrant);
  assert.equal(core.XAI_REFRESH_WINDOW_MS, c.refreshWindowMs);
  assert.equal(core.XAI_DEFAULT_LIFETIME_SECONDS, c.defaultLifetimeSeconds);
  assert.equal(core.XAI_DEVICE_MAX_WAIT_SECONDS, c.deviceMaxWaitSeconds);
  assert.equal(core.XAI_DEVICE_DEFAULT_EXPIRES_SECONDS, c.deviceDefaultExpiresSeconds);
  assert.equal(core.XAI_SLOW_DOWN_SECONDS, c.slowDownSeconds);
  assert.deepEqual({ ...core.XAI_FORM_HEADERS }, xaiVectors.headers);
  assert.deepEqual(Object.keys(core.XAI_FORM_HEADERS).sort(), ['Accept', 'Content-Type']);
  assert.deepEqual({ ...core.XAI_DEVICE_CODE_CONFIG }, {
    deviceCodeUrl: c.deviceCodeUrl, tokenUrl: c.tokenUrl, clientId: c.clientId, scope: c.scope,
  });
});

test('xAI request builders produce the conformance requests', () => {
  assert.equal(xaiVectors.requests.length, 3);
  for (const vector of xaiVectors.requests) {
    assert.equal(core.xaiTokenUrl(vector.input), vector.url, vector.name);
    assert.deepEqual(core.xaiTokenRequestFields(vector.input), vector.fields, vector.name);
    assert.deepEqual(decodedPairs(core.xaiFormBody(vector.input)), decodedPairs(vector.body), vector.name);
  }
});

test('xAI token responses parse per the conformance vectors', () => {
  for (const vector of xaiVectors.tokenResponses) {
    const got = core.parseXaiTokenResponse(vector.payload, { previousRefreshToken: vector.previousRefreshToken, now: xaiVectors.now });
    assert.deepEqual(got ?? null, vector.expected, vector.name);
  }
});

test('xAI device start responses parse per the conformance vectors', () => {
  for (const vector of xaiVectors.deviceStart) {
    assert.deepEqual(core.parseXaiDeviceStart(vector.payload, xaiVectors.now) ?? null, vector.expected, vector.name);
  }
});

test('xAI poll errors and refresh failures classify per the conformance vectors', () => {
  for (const vector of xaiVectors.pollErrors) {
    assert.equal(core.classifyXaiPollError(vector.status, vector.body), vector.expected, JSON.stringify(vector.body));
  }
  for (const vector of xaiVectors.refreshFailures) {
    assert.equal(core.classifyXaiRefreshFailure(vector.status), vector.expected, String(vector.status));
  }
});
