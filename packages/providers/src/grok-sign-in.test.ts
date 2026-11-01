// Built output: the sources use NodeNext `.js` imports, so tests run against dist/.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGrokSubscription,
  decodeGrokCredential,
  encodeGrokCredential,
  grok,
  GrokAuthError,
  grokCredentialFromDeviceTokens,
  grokCredentialFromLegacy,
  grokNeedsRefresh,
  GrokReconnectRequiredError,
  grokVaultBinding,
  isGrokSubscriptionRecord,
  refreshGrokCredential,
  type GrokTokenFetch,
} from '../dist/index.js';
import { createCredentialVault, XAI_FORM_HEADERS, XAI_TOKEN_URL } from '@byos/core';
import { readFileSync } from 'node:fs';

const vectors = JSON.parse(readFileSync(new URL('../../core/conformance/xai-oauth.json', import.meta.url), 'utf8'));
const refreshVector = vectors.requests.find((r: { name: string }) => r.name === 'refresh');
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const pairs = (body: string) => [...new URLSearchParams(body).entries()];

function tokenFetch(handler: (body: string, call: number) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit; body: string }> = [];
  const fetch: GrokTokenFetch = async (url, init) => {
    calls.push({ url, init, body: String(init.body) });
    return handler(String(init.body), calls.length);
  };
  return { fetch, calls };
}

function vault(initial: string | null) {
  const state = { value: initial };
  return { state, read: () => state.value, save: (value: string) => { state.value = value; } };
}

async function withApi<T>(handler: (url: string, init: RequestInit) => Response | Promise<Response>, run: (calls: Array<{ url: string; init: RequestInit }>) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return handler(String(input), init ?? {});
  }) as typeof fetch;
  try { return await run(calls); } finally { globalThis.fetch = original; }
}

const sseChunk = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
const sseOk = (text: string) => new Response(sseChunk(text) + 'data: [DONE]\n\n', { status: 200 });
async function drain(iter: AsyncIterable<{ type: string; text?: string }>) {
  let text = '';
  for await (const event of iter) if (event.type === 'text') text += event.text;
  return text;
}

const messages = [{ role: 'user' as const, content: 'hi' }];
const credential = (overrides: Record<string, unknown> = {}) =>
  encodeGrokCredential({ accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 3_600_000, ...overrides } as never);
const expiring = (overrides: Record<string, unknown> = {}) => credential({ expiresAt: Date.now() + 1_000, ...overrides });

test('Grok credential records round-trip, normalize and reject bare tokens', () => {
  const encoded = encodeGrokCredential({ accessToken: 'a', refreshToken: 'r', idToken: 'i', expiresAt: 5, label: 'me' });
  assert.ok(encoded.startsWith('grok-subscription:'));
  assert.deepEqual(decodeGrokCredential(encoded), { accessToken: 'a', refreshToken: 'r', idToken: 'i', expiresAt: 5, label: 'me' });
  assert.equal(decodeGrokCredential('xai-key'), undefined);
  assert.equal(decodeGrokCredential('grok-subscription:!!!'), undefined);
  assert.equal(decodeGrokCredential(`grok-subscription:${Buffer.from('{"accessToken":"a"}').toString('base64url')}`), undefined);
  assert.ok(isGrokSubscriptionRecord(encoded));
  assert.ok(!isGrokSubscriptionRecord('xai-key'));
  // Field order does not depend on the caller's key order.
  assert.equal(encodeGrokCredential({ expiresAt: 5, accessToken: 'a', refreshToken: 'r' } as never), encodeGrokCredential({ accessToken: 'a', refreshToken: 'r', expiresAt: 5 }));
  assert.equal(grokNeedsRefresh({ accessToken: 'a', expiresAt: Date.now() + 100_000 }), true);
  assert.equal(grokNeedsRefresh({ accessToken: 'a', expiresAt: Date.now() + 1_000_000 }), false);
  assert.equal(grokNeedsRefresh({ accessToken: 'a', expiresAt: 0 }), true);
});

test('device tokens and legacy pairs become records', () => {
  const made = decodeGrokCredential(grokCredentialFromDeviceTokens({ accessToken: 'a', refreshToken: 'r', idToken: 'i', expiresIn: 120 }, 1_000));
  assert.deepEqual(made, { accessToken: 'a', refreshToken: 'r', idToken: 'i', expiresAt: 121_000 });
  assert.equal(decodeGrokCredential(grokCredentialFromDeviceTokens({ accessToken: 'a' }, 1_000))?.expiresAt, 3_601_000);
  assert.equal(grokCredentialFromLegacy('tok', null), 'tok');
  assert.equal(decodeGrokCredential(grokCredentialFromLegacy('tok', { refreshToken: 'r' }))?.expiresAt, 0);
  assert.equal(decodeGrokCredential(grokCredentialFromLegacy('tok', { refreshToken: 'r', expiresAt: 9 }))?.expiresAt, 9);
});

test('refreshGrokCredential posts the conformance refresh request with exactly the two form headers', async () => {
  const { fetch, calls } = tokenFetch(() => json(200, { access_token: 'at-2', expires_in: 1800 }));
  const out = await refreshGrokCredential(fetch, { accessToken: 'at-1', refreshToken: 'synthetic-refresh-1', expiresAt: 1, label: 'me' }, undefined, 10_000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, XAI_TOKEN_URL);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(typeof calls[0].init.body, 'string');
  assert.deepEqual(pairs(calls[0].body), pairs(refreshVector.body));
  assert.deepEqual(calls[0].init.headers, { ...XAI_FORM_HEADERS });
  assert.deepEqual(Object.keys(calls[0].init.headers as object).sort(), ['Accept', 'Content-Type']);
  // Missing refresh_token keeps the previous one; the label survives.
  assert.deepEqual(decodeGrokCredential(out), { accessToken: 'at-2', refreshToken: 'synthetic-refresh-1', expiresAt: 10_000 + 1_800_000, label: 'me' });
});

test('refresh failures: 400/401 reconnect, everything else is a transient GrokAuthError with fixed text', async () => {
  const current = { accessToken: 'a', refreshToken: 'r', expiresAt: 1 };
  for (const status of [400, 401]) {
    await assert.rejects(() => refreshGrokCredential(tokenFetch(() => json(status, { error: 'invalid_grant' })).fetch, current), GrokReconnectRequiredError);
  }
  const secret = 'SECRET-UPSTREAM-TEXT';
  for (const status of [403, 429, 500, 503]) {
    await assert.rejects(() => refreshGrokCredential(tokenFetch(() => json(status, { error: secret })).fetch, current),
      (e: Error) => e instanceof GrokAuthError && !(e instanceof GrokReconnectRequiredError) && !e.message.includes(secret));
  }
  await assert.rejects(() => refreshGrokCredential(async () => { throw new Error(secret); }, current), (e: Error) => e instanceof GrokAuthError && !e.message.includes(secret));
  await assert.rejects(() => refreshGrokCredential(tokenFetch(() => json(200, { nope: true })).fetch, current), GrokAuthError);
  await assert.rejects(() => refreshGrokCredential(tokenFetch(() => new Response('not json', { status: 200 })).fetch, current), GrokAuthError);
  await assert.rejects(() => refreshGrokCredential(tokenFetch(() => new Response('x'.repeat(70_000), { status: 200 })).fetch, current), GrokAuthError);
  await assert.rejects(() => refreshGrokCredential(tokenFetch(() => { throw new Error('unused'); }).fetch, { accessToken: 'a', expiresAt: 1 }), GrokReconnectRequiredError);
  // An aborted caller sees the abort, not a Grok error.
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => refreshGrokCredential(async (_u, init) => { init.signal?.throwIfAborted(); return json(200, {}); }, current, controller.signal), (e: Error) => !(e instanceof GrokAuthError));
});

test('subscription accessToken: bare tokens and fresh records need no network', async () => {
  const v = vault(null);
  const net = tokenFetch(() => { throw new Error('must not be called'); });
  const sub = createGrokSubscription({ tokenFetch: net.fetch, readCredential: v.read, saveCredential: v.save });
  assert.equal(await sub.accessToken('xai-api-key'), 'xai-api-key');
  assert.equal(await sub.accessToken(credential()), 'at-1');
  await assert.rejects(() => sub.accessToken('grok-subscription:garbage'), GrokReconnectRequiredError);
  assert.equal(net.calls.length, 0);
});

test('subscription accessToken: no refresh token reconnects when forced or expired, else uses the access token', async () => {
  const v = vault(null);
  const sub = createGrokSubscription({ tokenFetch: tokenFetch(() => { throw new Error('unused'); }).fetch, readCredential: v.read, saveCredential: v.save });
  const soon = credential({ refreshToken: undefined, expiresAt: Date.now() + 1_000 });
  assert.equal(await sub.accessToken(soon), 'at-1');
  await assert.rejects(() => sub.accessToken(soon, { force: true }), GrokReconnectRequiredError);
  await assert.rejects(() => sub.accessToken(credential({ refreshToken: undefined, expiresAt: Date.now() - 1 })), GrokReconnectRequiredError);
});

test('subscription accessToken refreshes near expiry, saves the rotation and shares one flight', async () => {
  const start = expiring();
  const v = vault(start);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const net = tokenFetch(async () => { await gate; return json(200, { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 }); });
  const sub = createGrokSubscription({ tokenFetch: net.fetch, readCredential: v.read, saveCredential: v.save, namespace: 'test' });
  const first = sub.accessToken(start);
  const second = sub.accessToken(start);
  release();
  assert.deepEqual(await Promise.all([first, second]), ['at-2', 'at-2']);
  assert.equal(net.calls.length, 1);
  assert.equal(decodeGrokCredential(v.state.value)?.refreshToken, 'rt-2');
});

test('subscription accessToken never overwrites a credential that changed meanwhile', async () => {
  const start = expiring();
  const v = vault(start);
  const newer = credential({ accessToken: 'newer', refreshToken: 'rt-new' });
  const net = tokenFetch(async () => { v.state.value = newer; return json(200, { access_token: 'at-2', refresh_token: 'rt-2' }); });
  const sub = createGrokSubscription({ tokenFetch: net.fetch, readCredential: v.read, saveCredential: v.save });
  assert.equal(await sub.accessToken(start), 'newer');
  assert.equal(v.state.value, newer);
  // Disconnected meanwhile: reconnect, nothing saved.
  const gone = vault(start);
  const net2 = tokenFetch(async () => { gone.state.value = null; return json(200, { access_token: 'at-2' }); });
  const sub2 = createGrokSubscription({ tokenFetch: net2.fetch, readCredential: gone.read, saveCredential: gone.save });
  await assert.rejects(() => sub2.accessToken(start), GrokReconnectRequiredError);
  assert.equal(gone.state.value, null);
});

test('transient refresh failure keeps a still-valid access token, but not when forced or expired', async () => {
  const soon = expiring();
  const v = vault(soon);
  const failing = tokenFetch(() => json(500, {}));
  const sub = createGrokSubscription({ tokenFetch: failing.fetch, readCredential: v.read, saveCredential: v.save });
  assert.equal(await sub.accessToken(soon), 'at-1');
  await assert.rejects(() => sub.accessToken(soon, { force: true }), (e: Error) => e instanceof GrokAuthError && !(e instanceof GrokReconnectRequiredError));
  const gone = expiring({ expiresAt: Date.now() - 1_000 });
  const v2 = vault(gone);
  const sub2 = createGrokSubscription({ tokenFetch: failing.fetch, readCredential: v2.read, saveCredential: v2.save });
  await assert.rejects(() => sub2.accessToken(gone), (e: Error) => e instanceof GrokAuthError && !(e instanceof GrokReconnectRequiredError));
  // A dead grant reconnects even though the access token is still valid.
  const dead = createGrokSubscription({ tokenFetch: tokenFetch(() => json(400, { error: 'invalid_grant' })).fetch, readCredential: v.read, saveCredential: v.save });
  await assert.rejects(() => dead.accessToken(soon), GrokReconnectRequiredError);
});

test('grok() sends only the access token, never the encoded record', async () => {
  const v = vault(credential());
  const provider = grok({ subscription: { tokenFetch: tokenFetch(() => { throw new Error('unused'); }).fetch, readCredential: v.read, saveCredential: v.save } });
  await withApi(() => sseOk('hello'), async calls => {
    assert.equal(await drain(provider.stream(v.state.value!, { model: 'grok-4', messages })), 'hello');
    const sent = JSON.stringify(calls);
    assert.ok(!sent.includes('grok-subscription:'));
    assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer at-1');
    assert.ok(calls[0].url.startsWith('https://api.x.ai/'));
  });
  await withApi(() => json(200, { data: [{ id: 'grok-4' }] }), async calls => {
    await provider.listModels(v.state.value!);
    assert.ok(!JSON.stringify(calls).includes('grok-subscription:'));
    assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer at-1');
  });
});

test('grok() stream: a 401 forces one refresh and one retry; none after the first event', async () => {
  const v = vault(credential());
  const net = tokenFetch(() => json(200, { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 }));
  const provider = grok({ subscription: { tokenFetch: net.fetch, readCredential: v.read, saveCredential: v.save } });
  await withApi((_url, init) => new Headers(init.headers).get('authorization') === 'Bearer at-1' ? json(401, { error: 'expired' }) : sseOk('ok'), async calls => {
    assert.equal(await drain(provider.stream(v.state.value!, { model: 'grok-4', messages })), 'ok');
    assert.equal(calls.length, 2);
    assert.equal(net.calls.length, 1);
  });
  // A 401 on the retry surfaces; no third attempt.
  const v2 = vault(credential());
  const net2 = tokenFetch(() => json(200, { access_token: 'at-3' }));
  const p2 = grok({ subscription: { tokenFetch: net2.fetch, readCredential: v2.read, saveCredential: v2.save } });
  await withApi(() => json(401, {}), async calls => {
    await assert.rejects(() => drain(p2.stream(v2.state.value!, { model: 'grok-4', messages })), (e: { status?: number }) => e.status === 401);
    assert.equal(calls.length, 2);
    assert.equal(net2.calls.length, 1);
  });
  // After the first event a later failure is not retried.
  const v3 = vault(credential());
  const net3 = tokenFetch(() => json(200, { access_token: 'at-3' }));
  const p3 = grok({ subscription: { tokenFetch: net3.fetch, readCredential: v3.read, saveCredential: v3.save } });
  const broken = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(sseChunk('partial'))); },
    pull() { throw Object.assign(new Error('late'), { name: 'ProviderRequestError', status: 401 }); },
  }), { status: 200 });
  await withApi(() => broken, async calls => {
    await assert.rejects(() => drain(p3.stream(v3.state.value!, { model: 'grok-4', messages })));
    assert.equal(calls.length, 1);
    assert.equal(net3.calls.length, 0);
  });
});

test('grok() listModels retries a 401 once but never a 403; API keys are never refreshed', async () => {
  const v = vault(credential());
  const net = tokenFetch(() => json(200, { access_token: 'at-2', refresh_token: 'rt-2' }));
  const provider = grok({ subscription: { tokenFetch: net.fetch, readCredential: v.read, saveCredential: v.save } });
  await withApi((_u, init) => new Headers(init.headers).get('authorization') === 'Bearer at-1' ? json(401, {}) : json(200, { data: [{ id: 'grok-4' }] }), async calls => {
    assert.deepEqual((await provider.listModels(v.state.value!)).map(m => m.id), ['grok-4']);
    assert.equal(calls.length, 2);
    assert.equal(net.calls.length, 1);
  });
  const v2 = vault(credential());
  const net2 = tokenFetch(() => json(200, { access_token: 'at-2' }));
  const p2 = grok({ subscription: { tokenFetch: net2.fetch, readCredential: v2.read, saveCredential: v2.save } });
  await withApi(() => json(403, {}), async calls => {
    await assert.rejects(() => p2.listModels(v2.state.value!), (e: { status?: number }) => e.status === 403);
    assert.equal(calls.length, 1);
    assert.equal(net2.calls.length, 0);
  });
  await withApi(() => json(401, {}), async calls => {
    await assert.rejects(() => p2.listModels('xai-api-key'), (e: { status?: number }) => e.status === 401);
    assert.equal(calls.length, 1);
    assert.equal(net2.calls.length, 0);
  });
});

test('grok() without subscription uses a record until it expires, then asks to reconnect', async () => {
  const provider = grok();
  await withApi(() => sseOk('hi'), async () => {
    assert.equal(await drain(provider.stream(credential(), { model: 'grok-4', messages })), 'hi');
    await assert.rejects(() => drain(provider.stream(credential({ expiresAt: Date.now() - 1 }), { model: 'grok-4', messages })), GrokReconnectRequiredError);
  });
  // Sign-in methods are unchanged.
  assert.deepEqual(provider.signIn.map(m => m.kind), ['device-code', 'api-key']);
  assert.deepEqual(grok({ deviceCodeViaSite: false }).signIn.map(m => m.kind), ['api-key']);
});

test('grokVaultBinding round-trips with the core vault and upgrades legacy pairs', () => {
  const area = () => {
    const data = new Map<string, string>();
    return { get length() { return data.size; }, clear: () => data.clear(), getItem: (k: string) => data.get(k) ?? null, key: (i: number) => [...data.keys()][i] ?? null, removeItem: (k: string) => { data.delete(k); }, setItem: (k: string, x: string) => { data.set(k, x); } } as Storage;
  };
  const v = createCredentialVault({ prefix: 'grok-test:', storage: { session: area(), local: area() } });
  const binding = grokVaultBinding(v, 'xai-oauth');
  assert.equal(binding.readCredential(), '');
  // Legacy: bare token + separate refresh record with an unknown expiry refreshes at once.
  v.store('xai-oauth', 'legacy-at', 'browser');
  v.storeRefresh('xai-oauth', { refreshToken: 'legacy-rt' }, 'browser');
  const legacy = decodeGrokCredential(binding.readCredential());
  assert.deepEqual(legacy, { accessToken: 'legacy-at', refreshToken: 'legacy-rt', expiresAt: 0 });
  assert.ok(grokNeedsRefresh(legacy!));
  // Save splits the record back into the two slots, in the same persistence area.
  binding.saveCredential(encodeGrokCredential({ accessToken: 'at-2', refreshToken: 'rt-2', idToken: 'i', expiresAt: 42, label: 'me' }));
  assert.equal(v.read('xai-oauth'), 'at-2');
  assert.deepEqual(v.readRefresh('xai-oauth'), { refreshToken: 'rt-2', expiresAt: 42 });
  assert.equal(v.persistence('xai-oauth'), 'browser');
  // read -> save -> read is stable, which the refresh lock's string comparison relies on.
  const first = binding.readCredential();
  binding.saveCredential(first);
  assert.equal(binding.readCredential(), first);
  // An API key stays bare.
  v.store('xai-oauth', 'xai-key', 'session');
  assert.equal(binding.readCredential(), 'xai-key');
  // A record without a refresh grant clears the refresh slot.
  binding.saveCredential(encodeGrokCredential({ accessToken: 'only', expiresAt: 1 }));
  assert.equal(v.readRefresh('xai-oauth'), null);
});

test('a legacy pair refreshes immediately through the subscription', async () => {
  const area = () => {
    const data = new Map<string, string>();
    return { get length() { return data.size; }, clear: () => data.clear(), getItem: (k: string) => data.get(k) ?? null, key: (i: number) => [...data.keys()][i] ?? null, removeItem: (k: string) => { data.delete(k); }, setItem: (k: string, x: string) => { data.set(k, x); } } as Storage;
  };
  const v = createCredentialVault({ prefix: 'grok-test:', storage: { session: area(), local: area() } });
  v.store('xai-oauth', 'legacy-at', 'browser');
  v.storeRefresh('xai-oauth', { refreshToken: 'legacy-rt' }, 'browser');
  const net = tokenFetch(() => json(200, { access_token: 'fresh-at', refresh_token: 'fresh-rt', expires_in: 3600 }));
  const provider = grok({ subscription: { tokenFetch: net.fetch, ...grokVaultBinding(v, 'xai-oauth') } });
  const binding = grokVaultBinding(v, 'xai-oauth');
  await withApi(() => sseOk('ok'), async calls => {
    assert.equal(await drain(provider.stream(binding.readCredential(), { model: 'grok-4', messages })), 'ok');
    assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer fresh-at');
  });
  assert.equal(net.calls.length, 1);
  assert.equal(v.read('xai-oauth'), 'fresh-at');
  assert.equal(v.readRefresh('xai-oauth')?.refreshToken, 'fresh-rt');
});
