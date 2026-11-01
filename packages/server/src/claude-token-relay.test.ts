import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { CLAUDE_OAUTH_CLIENT_ID, CLAUDE_PASTE_REDIRECT_URI, CLAUDE_TOKEN_URL } from '@byos/core';
import { createClaudeTokenRelay, type ClaudeTokenRelayOptions } from '../dist/claude-token-relay.js';

const origin = 'https://app.example';
const exchange = {
  grant_type: 'authorization_code', code: 'code-1', state: 's'.repeat(43), client_id: CLAUDE_OAUTH_CLIENT_ID,
  redirect_uri: CLAUDE_PASTE_REDIRECT_URI, code_verifier: 'v'.repeat(43),
};
const refresh = { grant_type: 'refresh_token', refresh_token: 'rt-secret-1', client_id: CLAUDE_OAUTH_CLIENT_ID };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Upstream = { url: string; init: RequestInit };
function setup(overrides: Partial<ClaudeTokenRelayOptions> = {}, upstream: (call: Upstream) => Response | Promise<Response> = () => json(200, { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 })) {
  const calls: Upstream[] = [];
  const relay = createClaudeTokenRelay({
    basePath: '/api/ai/claude',
    allowedOrigins: () => new Set([origin]),
    enabled: () => true,
    fetch: async (url, init) => { calls.push({ url, init }); return upstream({ url, init }); },
    ...overrides,
  });
  return { relay, calls };
}
const request = (body: unknown = exchange, extra: Record<string, unknown> = {}) => ({
  origin, contentType: 'application/json', body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)), address: '203.0.113.9', ...extra,
});

test('exchanges and refreshes through the fixed endpoint, re-serializing only the validated grant', async () => {
  const { relay, calls } = setup({}, () => json(200, {
    access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600, token_type: 'Bearer', scope: 'user:inference',
    account: { email_address: 'a@b.example', uuid: 'drop-me' }, organization: { uuid: 'drop-me' }, anything: 'drop-me',
  }));
  const done = await relay.handle(request());
  assert.equal(done.status, 200);
  assert.deepEqual(done.body, { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600, token_type: 'Bearer', scope: 'user:inference', account: { email_address: 'a@b.example' } });
  assert.equal(calls[0].url, CLAUDE_TOKEN_URL);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'error');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), exchange);
  assert.deepEqual(Object.keys(calls[0].init.headers as object).sort(), ['accept', 'content-type']);
  assert.ok(calls[0].init.signal);
  const renewed = await relay.handle(request(refresh));
  assert.equal(renewed.status, 200);
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), refresh);
});

test('rejects in the documented order before any upstream call', async () => {
  const closed = setup({ enabled: () => false });
  assert.equal((await closed.relay.handle(request())).status, 503);
  const { relay, calls } = setup();
  assert.equal((await relay.handle(request(exchange, { origin: undefined }))).status, 403);
  assert.equal((await relay.handle(request(exchange, { origin: 'https://evil.example' }))).status, 403);
  assert.equal((await relay.handle(request(exchange, { secFetchSite: 'cross-site' }))).status, 403);
  assert.equal((await relay.handle(request(exchange, { secFetchSite: 'same-site' }))).status, 403);
  assert.equal((await relay.handle(request(exchange, { secFetchSite: 'same-origin' }))).status, 200);
  const before = calls.length;
  assert.equal((await relay.handle(request(exchange, { contentType: 'text/plain' }))).status, 415);
  assert.equal((await relay.handle(request(exchange, { contentType: undefined }))).status, 415);
  assert.equal((await relay.handle(request(exchange, { contentType: 'application/json; charset=utf-8' }))).status, 200);
  assert.equal((await relay.handle(request(exchange, { bodyError: 'large' }))).status, 413);
  assert.equal((await relay.handle({ ...request(), body: Buffer.alloc(4097, 97) })).status, 413);
  assert.equal((await relay.handle({ ...request(), body: { grant_type: 'refresh_token' } })).status, 400);
  assert.equal((await relay.handle(request('not json'))).status, 400);
  assert.equal((await relay.handle(request({ ...exchange, redirect_uri: 'https://evil.example/cb' }))).status, 400);
  assert.equal((await relay.handle(request({ ...refresh, extra: 'x' }))).status, 400);
  assert.equal((await relay.handle(request([exchange]))).status, 400);
  assert.equal(calls.length - before, 1);
});

test('requires a signed-in session when resolveSession is configured, with exactly one reader', async () => {
  assert.throws(() => createClaudeTokenRelay({ basePath: '/x', allowedOrigins: () => new Set(), enabled: () => true, resolveSession: async () => undefined }), /exactly one/);
  assert.throws(() => createClaudeTokenRelay({ basePath: '/x', allowedOrigins: () => new Set(), enabled: () => true, resolveSession: async () => undefined, sessionHeader: 'x-s', readSession: () => 's' }), /exactly one/);
  assert.throws(() => createClaudeTokenRelay({ basePath: '/x', allowedOrigins: () => new Set(), enabled: () => true, sessionHeader: 'x-s' }), /need resolveSession/);
  assert.throws(() => createClaudeTokenRelay({ basePath: '/x', allowedOrigins: () => new Set(), enabled: () => true, resolveSession: async () => undefined, sessionHeader: 'bad header' }), /header name/);
  const { relay, calls } = setup({ resolveSession: async session => session === 'valid' ? { ownerKey: 'acct' } : undefined, sessionHeader: 'x-session' });
  assert.equal((await relay.handle(request())).status, 401);
  assert.equal((await relay.handle(request(exchange, { session: '' }))).status, 401);
  assert.equal((await relay.handle(request(exchange, { session: 'x'.repeat(513) }))).status, 401);
  assert.equal((await relay.handle(request(exchange, { session: 'stale' }))).status, 401);
  assert.equal(calls.length, 0);
  assert.equal((await relay.handle(request(exchange, { session: 'valid' }))).status, 200);
  const broken = setup({ resolveSession: async () => { throw new Error('db down'); }, readSession: () => 'valid' });
  assert.equal((await broken.relay.handle(request(exchange, { session: 'valid' }))).status, 503);
});

test('rate limits per key, globally, and bounds the bucket table; windows reset', async () => {
  let clock = 1_000_000;
  const { relay } = setup({ now: () => clock });
  for (let i = 0; i < 20; i++) assert.equal((await relay.handle(request())).status, 200);
  assert.equal((await relay.handle(request())).status, 429);
  assert.equal((await relay.handle(request(exchange, { address: '198.51.100.7' }))).status, 200, 'another key is unaffected');
  clock += 60_000;
  assert.equal((await relay.handle(request())).status, 200);

  const global = setup({ now: () => clock });
  let ok = 0, limited = 0;
  for (let i = 0; i < 310; i++) {
    const status = (await global.relay.handle(request(exchange, { address: `k${i}` }))).status;
    if (status === 200) ok++; else if (status === 429) limited++;
  }
  assert.deepEqual([ok, limited], [300, 10]);

  const many = setup({ now: () => clock });
  let rejected = 0;
  const all = await Promise.all(Array.from({ length: 10_050 }, (_, i) => many.relay.handle(request(exchange, { address: `a${i}` }))));
  rejected = all.filter(result => result.status === 429).length;
  assert.ok(rejected > 0);
});

test('maps upstream outcomes without echoing upstream text', async () => {
  const secret = 'UPSTREAM-SECRET-TEXT';
  for (const status of [400, 401, 403]) {
    const { relay } = setup({}, () => json(status, { error: secret, error_description: secret }));
    assert.deepEqual(await relay.handle(request()), { status, body: { error: 'invalid_grant' } });
  }
  for (const response of [() => json(500, { error: secret }), () => json(404, {}), () => json(429, {}), () => json(200, { refresh_token: 'rt' }),
    () => new Response('not json', { status: 200 }), () => new Response('x'.repeat(70 * 1024), { status: 200 }), () => { throw new Error(secret); }]) {
    const { relay } = setup({}, response);
    const result = await relay.handle(request());
    assert.equal(result.status, 502);
    assert.ok(!JSON.stringify(result).includes(secret));
  }
});

async function withHttp<T>(relayOptions: Partial<ClaudeTokenRelayOptions>, upstream: Parameters<typeof setup>[1], run: (base: string, calls: Upstream[]) => Promise<T>, before?: (app: express.Express) => void): Promise<T> {
  const { relay, calls } = setup(relayOptions, upstream);
  const app = express();
  before?.(app);
  app.use(relay.router);
  const server: Server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections(); }
}

test('the router serves status and token, with no-store headers and no logging', async () => {
  const logged: unknown[][] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(name => {
    const original = console[name];
    console[name] = (...args: unknown[]) => { logged.push(args); };
    return () => { console[name] = original; };
  });
  try {
    await withHttp({}, undefined, async (base, calls) => {
      const status = await fetch(`${base}/api/ai/claude/status`);
      assert.deepEqual(await status.json(), { enabled: true });
      assert.equal(status.headers.get('cache-control'), 'no-store');
      const ok = await fetch(`${base}/api/ai/claude/token`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(refresh) });
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get('cache-control'), 'no-store');
      assert.equal(ok.headers.get('pragma'), 'no-cache');
      assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(ok.headers.get('referrer-policy'), 'no-referrer');
      assert.equal((await ok.json() as { access_token: string }).access_token, 'at-new');
      assert.equal(calls.length, 1);

      const wrongType = await fetch(`${base}/api/ai/claude/token`, { method: 'POST', headers: { 'content-type': 'text/plain', origin }, body: JSON.stringify(refresh) });
      assert.equal(wrongType.status, 415);
      assert.equal(wrongType.headers.get('cache-control'), 'no-store');
      const noOrigin = await fetch(`${base}/api/ai/claude/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(refresh) });
      assert.equal(noOrigin.status, 403);
      const big = await fetch(`${base}/api/ai/claude/token`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ ...refresh, refresh_token: 'x'.repeat(5000) }) });
      assert.equal(big.status, 413);
      assert.equal(big.headers.get('cache-control'), 'no-store');
      const empty = await fetch(`${base}/api/ai/claude/token`, { method: 'POST', headers: { 'content-type': 'application/json', origin } });
      assert.equal(empty.status, 400);
      const garbled = await fetch(`${base}/api/ai/claude/token`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{' });
      assert.equal(garbled.status, 400);
      assert.equal(calls.length, 1);
    });
  } finally { for (const restore of spies) restore(); }
  assert.deepEqual(logged, []);
});

test('the status route reports a closed gate, and a body already parsed upstream is rejected', async () => {
  await withHttp({ enabled: () => false }, undefined, async base => {
    assert.deepEqual(await (await fetch(`${base}/api/ai/claude/status`)).json(), { enabled: false });
    const refused = await fetch(`${base}/api/ai/claude/token`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(refresh) });
    assert.equal(refused.status, 503);
  });
  await withHttp({}, undefined, async (base, calls) => {
    const result = await fetch(`${base}/api/ai/claude/token`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(refresh) });
    assert.equal(result.status, 400);
    assert.equal(calls.length, 0);
  }, app => app.use(express.json()));
});

test('the router reads the session header', async () => {
  await withHttp({ resolveSession: async s => s === 'valid' ? { ownerKey: 'a' } : undefined, sessionHeader: 'x-session' }, undefined, async (base, calls) => {
    const send = (session?: string) => fetch(`${base}/api/ai/claude/token`, { method: 'POST', headers: { 'content-type': 'application/json', origin, ...(session ? { 'x-session': session } : {}) }, body: JSON.stringify(refresh) });
    assert.equal((await send()).status, 401);
    assert.equal((await send('nope')).status, 401);
    assert.equal((await send('valid')).status, 200);
    assert.equal(calls.length, 1);
  });
});

test('rejects unsafe base paths', () => {
  for (const basePath of ['', 'api', '//x', '/a//b', '/a/../b', '/a?b', '/a b']) {
    assert.throws(() => createClaudeTokenRelay({ basePath, allowedOrigins: () => new Set(), enabled: () => true }), TypeError, basePath);
  }
});
