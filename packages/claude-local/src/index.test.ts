import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createClaudeClient, thinksByDefault, ClaudeError, BETA_HEADER, SYSTEM_PREFIX, CLIENT_ID, TOKEN_URL, type ClaudeClientOptions } from '../dist/index.js';

async function fixture(t: { after(fn: () => unknown): void }, over: Partial<ClaudeClientOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'byos-claude-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let saved: string | null = null, clock = 1_000_000, authorization!: URL;
  const c = { tokenBodies: [] as Record<string, string>[], api: [] as { url: string; headers: Record<string, string>; body: any }[], tokenStatus: 200, models: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }, { id: 'claude-haiku-4-5' }], sse: '', callback: true };
  const sse = (events: object[]) => events.map(e => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join('');
  c.sse = sse([
    { type: 'message_start' }, { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } }, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } }, { type: 'message_stop' },
  ]);
  const options: ClaudeClientOptions = {
    appName: 'Test', namespace: 'byos-claude-test', storageDirectory: directory, now: () => clock, loopbackPort: 0,
    credentialStore: { read: async () => saved, write: async v => { saved = v; } },
    openBrowser: async url => {
      authorization = new URL(url);
      if (!c.callback) return;
      const cb = new URL(authorization.searchParams.get('redirect_uri')!);
      cb.hostname = '127.0.0.1';
      cb.searchParams.set('code', 'fake-code'); cb.searchParams.set('state', authorization.searchParams.get('state')!);
      assert.equal((await fetch(cb)).status, 200);
    },
    fetch: baseFetch,
    ...over,
  };
  async function baseFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
      assert.equal(init?.redirect, 'error');
      const u = String(url), headers = init?.headers as Record<string, string>;
      if (u === TOKEN_URL) {
        const body = JSON.parse(String(init?.body)); c.tokenBodies.push(body);
        if (c.tokenStatus !== 200) return Response.json({ error: 'invalid_grant' }, { status: c.tokenStatus });
        return Response.json({ access_token: `access-${c.tokenBodies.length}`, refresh_token: `refresh-${c.tokenBodies.length}`, expires_in: 3600, account: { email_address: 'me@example.test' } });
      }
      c.api.push({ url: u, headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (u.includes('/models')) return Response.json({ data: c.models, has_more: false });
      if (u.endsWith('/messages')) return new Response(c.sse, { headers: { 'Content-Type': 'text/event-stream' } });
      throw new Error('unexpected ' + u);
  }
  return { client: createClaudeClient(options), baseFetch, c, advance: (ms: number) => { clock += ms; }, auth: () => authorization, saved: () => saved };
}

test('loopback sign-in: localhost redirect, PKCE, scopes, token exchange, account label', async t => {
  const { client, c, auth, saved } = await fixture(t);
  assert.deepEqual(await client.status(), { connected: false });
  const status = await client.signIn();
  assert.deepEqual(status, { connected: true, account: { label: 'me@example.test' } });
  const a = auth();
  assert.equal(a.origin + a.pathname, 'https://claude.com/cai/oauth/authorize');
  assert.equal(a.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(a.searchParams.get('scope'), 'user:profile user:inference');
  assert.equal(a.searchParams.get('code_challenge_method'), 'S256');
  assert.match(a.searchParams.get('redirect_uri')!, /^http:\/\/localhost:\d+\/callback$/);
  const body = c.tokenBodies[0];
  assert.equal(body.grant_type, 'authorization_code');
  assert.equal(body.code, 'fake-code');
  assert.equal(body.redirect_uri, a.searchParams.get('redirect_uri'));
  assert.equal(createHash('sha256').update(body.code_verifier).digest('base64url'), a.searchParams.get('code_challenge'));
  assert.ok(saved()!.includes('access-1'));
});

test('loopback rejects a wrong state', async t => {
  const { client } = await fixture(t, { openBrowser: async url => {
    const cb = new URL(new URL(url).searchParams.get('redirect_uri')!); cb.hostname = '127.0.0.1'; cb.searchParams.set('code', 'x'); cb.searchParams.set('state', 'wrong');
    assert.equal((await fetch(cb)).status, 400);
  } });
  await assert.rejects(client.signIn(), (e: ClaudeError) => e.code === 'auth-failed');
});

test('a busy loopback port reports port-in-use', async t => {
  const blocker = createServer(); await new Promise<void>(r => blocker.listen(0, '127.0.0.1', r));
  t.after(() => blocker.close());
  const { client } = await fixture(t, { loopbackPort: (blocker.address() as { port: number }).port });
  await assert.rejects(client.signIn(), (e: ClaudeError) => e.code === 'port-in-use');
});

test('paste sign-in accepts CODE#STATE and a bare code, rejects a wrong state', async t => {
  const { client, c } = await fixture(t);
  const { url } = client.beginPasteSignIn(); const u = new URL(url);
  assert.equal(u.searchParams.get('redirect_uri'), 'https://platform.claude.com/oauth/code/callback');
  await assert.rejects(client.completePasteSignIn('abc#other'), (e: ClaudeError) => e.code === 'auth-failed');
  assert.equal(c.tokenBodies.length, 0);
  assert.equal((await client.completePasteSignIn(`abc#${u.searchParams.get('state')}`)).connected, true);
  assert.equal(c.tokenBodies[0].code, 'abc');
  client.beginPasteSignIn();
  assert.equal((await client.completePasteSignIn('  bare-code ')).connected, true);
  assert.equal(c.tokenBodies[1].code, 'bare-code');
  await assert.rejects(client.completePasteSignIn('x'), (e: ClaudeError) => e.code === 'auth-failed'); // no flow in progress
});

test('generate sends Bearer, beta header and the Claude Code system prefix, and streams text', async t => {
  const { client, c } = await fixture(t);
  await client.signIn();
  const parts: string[] = [];
  const { text } = await client.generate({ model: 'claude-sonnet-5-5', input: 'hi', instructions: 'be brief', maxTokens: 300, onText: d => parts.push(d) });
  assert.equal(text, 'Hello world'); assert.deepEqual(parts, ['Hello ', 'world']);
  const req = c.api.find(r => r.url.endsWith('/messages'))!;
  assert.equal(req.headers.Authorization, 'Bearer access-1');
  assert.equal(req.headers['anthropic-beta'], BETA_HEADER);
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(req.body.system, [{ type: 'text', text: SYSTEM_PREFIX }, { type: 'text', text: 'be brief' }]);
  assert.equal(req.body.max_tokens, 4096); // 5-series floor
  assert.deepEqual(req.body.output_config, { effort: 'low' });
  await client.generate({ model: 'claude-haiku-4-5', input: 'hi', maxTokens: 300 });
  const older = c.api.filter(r => r.url.endsWith('/messages'))[1];
  assert.equal(older.body.max_tokens, 300); assert.equal(older.body.output_config, undefined);
});

test('thinksByDefault', () => {
  for (const m of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1']) assert.equal(thinksByDefault(m), true, m);
  for (const m of ['claude-opus-4-8', 'claude-haiku-4-5', 'claude-3-5-sonnet-20241022', 'gpt-5']) assert.equal(thinksByDefault(m), false, m);
});

test('listModels reads the live list', async t => {
  const { client } = await fixture(t);
  await client.signIn();
  assert.deepEqual(await client.listModels(), [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }, { id: 'claude-haiku-4-5', name: 'claude-haiku-4-5' }]);
});

test('an expired token refreshes with the rotated replacement; a rejected refresh requires sign-in', async t => {
  const { client, c, advance } = await fixture(t);
  await client.signIn();
  advance(3_600_000);
  await client.listModels();
  assert.deepEqual(c.tokenBodies[1], { grant_type: 'refresh_token', refresh_token: 'refresh-1', client_id: CLIENT_ID });
  assert.equal(c.api.at(-1)!.headers.Authorization, 'Bearer access-2');
  advance(3_600_000); c.tokenStatus = 400;
  await assert.rejects(client.listModels(), (e: ClaudeError) => e.code === 'reconnect-required');
  assert.equal((await client.status()).connected, false);
});

test('a 401 forces one refresh and retries once, for generate and listModels', async t => {
  let rejectNext = 0;
  const f = await fixture(t, { fetch: async (url, init) => {
    if (rejectNext > 0 && String(url) !== TOKEN_URL) { rejectNext--; f.c.api.push({ url: String(url), headers: init?.headers as Record<string, string>, body: undefined }); return Response.json({ error: 'expired' }, { status: 401 }); }
    return f.baseFetch(url, init);
  } });
  await f.client.signIn();
  rejectNext = 1;
  assert.deepEqual(await f.client.generate({ model: 'claude-sonnet-4-5', input: 'hi' }), { text: 'Hello world' });
  assert.equal(f.c.tokenBodies.length, 2);
  assert.equal(f.c.tokenBodies[1].grant_type, 'refresh_token');
  assert.deepEqual(f.c.api.map(a => a.headers.Authorization), ['Bearer access-1', 'Bearer access-2']);
  rejectNext = 1;
  assert.equal((await f.client.listModels()).length, 2);
  assert.equal(f.c.tokenBodies.length, 3);
  rejectNext = 2;
  await assert.rejects(f.client.listModels(), (e: ClaudeError) => e.code === 'reconnect-required');
  assert.equal(f.c.tokenBodies.length, 4);
});

test('a 401 followed by a rejected refresh requires sign-in and clears the tokens', async t => {
  let reject = false;
  const f = await fixture(t, { fetch: async (url, init) => reject && String(url) !== TOKEN_URL ? (f.c.tokenStatus = 401, Response.json({}, { status: 401 })) : f.baseFetch(url, init) });
  await f.client.signIn();
  reject = true;
  await assert.rejects(f.client.generate({ model: 'claude-sonnet-4-5', input: 'hi' }), (e: ClaudeError) => e.code === 'reconnect-required');
  assert.equal((await f.client.status()).connected, false);
  assert.equal(f.c.tokenBodies.length, 2);
});

test('API failures map to codes without leaking text', async t => {
  const { client } = await fixture(t, { fetch: async url => String(url) === TOKEN_URL ? Response.json({ access_token: 'a', expires_in: 3600 }) : Response.json({ error: { message: 'secret-detail' } }, { status: 429 }) });
  await client.signIn();
  await assert.rejects(client.generate({ model: 'm', input: 'x' }), (e: ClaudeError) => e.code === 'quota' && !e.message.includes('secret'));
});

test('disconnect removes the tokens', async t => {
  const { client, saved } = await fixture(t);
  await client.signIn(); await client.disconnect();
  assert.equal((await client.status()).connected, false);
  assert.ok(!saved()!.includes('access-1'));
});
