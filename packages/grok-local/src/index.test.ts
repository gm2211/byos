import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGrokClient, GrokError, XAI_DEVICE_CODE_URL, XAI_TOKEN_URL, XAI_OAUTH_CLIENT_ID, type GrokClientOptions } from '../dist/index.js';

const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

async function fixture(t: { after(fn: () => unknown): void }, script: (url: string, form: Record<string, string>, n: number) => Response | Promise<Response>, over: Partial<GrokClientOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'byos-grok-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let saved: string | null = null, clock = 1_000_000;
  const calls: Array<{ url: string; form: Record<string, string>; init: RequestInit }> = [];
  const sleeps: number[] = [];
  const client = createGrokClient({
    appName: 'Test', namespace: 'byos-grok-test', storageDirectory: directory, now: () => clock,
    sleep: async ms => { sleeps.push(ms); clock += ms; },
    credentialStore: { read: async () => saved, write: async v => { saved = v; } },
    fetch: (async (url: string, init: RequestInit) => {
      assert.equal(init.redirect, 'error');
      assert.deepEqual(Object.keys(init.headers as object).sort(), ['Accept', 'Content-Type']);
      const form = Object.fromEntries(new URLSearchParams(String(init.body)));
      calls.push({ url: String(url), form, init });
      return script(String(url), form, calls.length);
    }) as typeof fetch,
    ...over,
  });
  return { client, calls, sleeps, advance: (ms: number) => { clock += ms; }, saved: () => saved, setSaved: (v: string | null) => { saved = v; }, now: () => clock };
}

const start = (extra: object = {}) => Response.json({ device_code: 'dev', user_code: 'ABCD-1234', verification_uri: 'https://x.ai/device', verification_uri_complete: 'https://x.ai/device?c=ABCD-1234', interval: 1, expires_in: 300, ...extra });

test('device flow emits URL + code, polls through pending/slow_down, stores tokens, labels from the id_token', async t => {
  const idToken = jwt({ email: 'me@example.test' });
  const f = await fixture(t, (url, form, n) => {
    if (url === XAI_DEVICE_CODE_URL) return start();
    if (n === 2) return Response.json({ error: 'authorization_pending' }, { status: 400 });
    if (n === 3) return Response.json({ error: 'slow_down' }, { status: 400 });
    return Response.json({ access_token: 'first-access', refresh_token: 'r1', id_token: idToken, expires_in: 3600 });
  });
  let shown: unknown;
  const status = await f.client.signIn({ onCode: info => { shown = info; } });
  assert.deepEqual(shown, { verificationUrl: 'https://x.ai/device?c=ABCD-1234', userCode: 'ABCD-1234' });
  assert.deepEqual(status, { connected: true, account: { label: 'me@example.test' } });
  assert.equal(f.calls[0].url, XAI_DEVICE_CODE_URL);
  assert.equal(f.calls[0].form.client_id, XAI_OAUTH_CLIENT_ID);
  assert.equal(f.calls.filter(c => c.form.grant_type?.includes('device_code')).length, 3);
  assert.deepEqual(f.sleeps, [1000, 1000, 6000]);
  assert.equal(JSON.parse(f.saved()!).tokens.refresh, 'r1');
  assert.deepEqual(await f.client.status(), status);
  await f.client.disconnect();
  assert.deepEqual(await f.client.status(), { connected: false });
});

test('label falls back to "Grok subscription"', async t => {
  const f = await fixture(t, url => url === XAI_DEVICE_CODE_URL ? start() : Response.json({ access_token: 'a', refresh_token: 'r' }));
  assert.equal((await f.client.signIn({ onCode() {} })).account?.label, 'Grok subscription');
});

test('declined, expired, malformed and unreachable sign-ins fail with fixed codes', async t => {
  const code = async (script: Parameters<typeof fixture>[1]) => {
    const f = await fixture(t, script);
    try { await f.client.signIn({ onCode() {} }); } catch (e) { return (e as GrokError).code; }
    return 'none';
  };
  assert.equal(await code(url => url === XAI_DEVICE_CODE_URL ? start() : Response.json({ error: 'access_denied' }, { status: 400 })), 'declined');
  assert.equal(await code(url => url === XAI_DEVICE_CODE_URL ? start() : Response.json({ error: 'authorization_denied' }, { status: 400 })), 'declined');
  assert.equal(await code(url => url === XAI_DEVICE_CODE_URL ? start() : Response.json({ error: 'expired_token' }, { status: 400 })), 'expired');
  assert.equal(await code(url => url === XAI_DEVICE_CODE_URL ? start() : Response.json({ error: 'weird' }, { status: 400 })), 'auth-failed');
  assert.equal(await code(url => url === XAI_DEVICE_CODE_URL ? start() : Response.json({ nothing: 1 })), 'auth-failed');
  assert.equal(await code(url => url === XAI_DEVICE_CODE_URL ? start({ verification_uri: 'http://x.ai/d', verification_uri_complete: undefined }) : Response.json({})), 'unavailable');
  assert.equal(await code(() => { throw new Error('offline'); }), 'unavailable');
  // Never-approved codes time out as expired once the deadline passes.
  assert.equal(await code(url => url === XAI_DEVICE_CODE_URL ? start({ expires_in: 3 }) : Response.json({ error: 'authorization_pending' }, { status: 400 })), 'expired');
});

test('signIn is single-flight and cancelable', async t => {
  const f = await fixture(t, url => url === XAI_DEVICE_CODE_URL ? start() : Response.json({ error: 'authorization_pending' }, { status: 400 }), {
    sleep: () => new Promise(() => {}),
  });
  const controller = new AbortController();
  const first = f.client.signIn({ onCode() {}, signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 20));
  await assert.rejects(() => f.client.signIn({ onCode() {} }), (e: GrokError) => e.code === 'busy');
  controller.abort();
  // The pending sleep never settles in this fixture, so cancel through a fresh client to prove abort mapping.
  const g = await fixture(t, () => start());
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(() => g.client.signIn({ onCode() {}, signal: aborted.signal }), (e: GrokError) => e.code === 'canceled');
  void first.catch(() => {});
});

const seed = (f: Awaited<ReturnType<typeof fixture>>, tokens: object) => f.setSaved(JSON.stringify({ version: 1, tokens }));

test('accessToken: fresh tokens need no network; near expiry refreshes and keeps the old grant if none returns', async t => {
  const f = await fixture(t, (_u, form) => Response.json({ access_token: 'new-access', expires_in: 3600 }));
  seed(f, { access: 'old', refresh: 'r', expiresAt: f.now() + 3_600_000 });
  assert.equal(await f.client.accessToken(), 'old');
  assert.equal(f.calls.length, 0);
  f.advance(3_600_000 - 200_000); // inside the 5 minute window
  assert.equal(await f.client.accessToken(), 'new-access');
  assert.deepEqual(f.calls[0].form, { grant_type: 'refresh_token', refresh_token: 'r', client_id: XAI_OAUTH_CLIENT_ID });
  assert.equal(f.calls[0].url, XAI_TOKEN_URL);
  assert.equal(JSON.parse(f.saved()!).tokens.refresh, 'r');
});

test('a rotated grant is persisted even when the caller cancels mid-refresh', async t => {
  const controller = new AbortController();
  const f = await fixture(t, () => { controller.abort(); return Response.json({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 }); });
  seed(f, { access: 'old', refresh: 'r1', expiresAt: f.now() + 1000 });
  await assert.rejects(() => f.client.accessToken(controller.signal), (e: GrokError) => e.code === 'canceled');
  assert.equal(f.calls.length, 1);
  assert.equal(JSON.parse(f.saved()!).tokens.refresh, 'r2');
});

test('refresh 400/401 deletes the tokens and reconnects; other failures keep a valid token', async t => {
  for (const status of [400, 401]) {
    const f = await fixture(t, () => Response.json({ error: 'invalid_grant' }, { status }));
    seed(f, { access: 'old', refresh: 'r', expiresAt: f.now() + 1000 });
    await assert.rejects(() => f.client.accessToken(), (e: GrokError) => e.code === 'reconnect-required');
    assert.deepEqual(await f.client.status(), { connected: false });
  }
  const f = await fixture(t, () => Response.json({}, { status: 503 }));
  seed(f, { access: 'old', refresh: 'r', expiresAt: f.now() + 1000 });
  assert.equal(await f.client.accessToken(), 'old');
  assert.equal((await f.client.status()).connected, true);
  f.advance(2000); // expired now
  await assert.rejects(() => f.client.accessToken(), (e: GrokError) => e.code === 'unavailable');
  assert.equal((await f.client.status()).connected, true);
  const offline = await fixture(t, () => { throw new Error('offline'); });
  seed(offline, { access: 'old', refresh: 'r', expiresAt: offline.now() - 1 });
  await assert.rejects(() => offline.client.accessToken(), (e: GrokError) => e.code === 'unavailable');
});

test('no stored tokens, or no refresh grant once expired, means reconnect-required', async t => {
  const f = await fixture(t, () => { throw new Error('unused'); });
  await assert.rejects(() => f.client.accessToken(), (e: GrokError) => e.code === 'reconnect-required');
  seed(f, { access: 'a', expiresAt: f.now() + 1000 });
  assert.equal(await f.client.accessToken(), 'a');
  seed(f, { access: 'a', expiresAt: f.now() - 1 });
  await assert.rejects(() => f.client.accessToken(), (e: GrokError) => e.code === 'reconnect-required');
  assert.equal(f.calls.length, 0);
});

test('rejected token: refreshes now, but skips the refresh when another process already rotated it', async t => {
  const f = await fixture(t, () => Response.json({ access_token: 'rotated', refresh_token: 'r2', expires_in: 3600 }));
  seed(f, { access: 'stale', refresh: 'r1', expiresAt: f.now() + 3_600_000 });
  assert.equal(await f.client.accessToken(undefined, { rejected: 'stale' }), 'rotated');
  assert.equal(f.calls.length, 1);
  // The caller still holds 'stale'; storage already has 'rotated', so no second grant is spent.
  assert.equal(await f.client.accessToken(undefined, { rejected: 'stale' }), 'rotated');
  assert.equal(f.calls.length, 1);
});

test('concurrent callers serialize on the process lock and spend one grant', async t => {
  const f = await fixture(t, async () => { await new Promise(resolve => setTimeout(resolve, 20)); return Response.json({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 }); });
  seed(f, { access: 'old', refresh: 'r1', expiresAt: f.now() + 1000 });
  const results = await Promise.all([f.client.accessToken(), f.client.accessToken(), f.client.accessToken()]);
  assert.deepEqual(results, ['a2', 'a2', 'a2']);
  assert.equal(f.calls.length, 1);
});

test('run retries once on a 401 with a forced refresh, never on other statuses or twice', async t => {
  const f = await fixture(t, () => Response.json({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 }));
  seed(f, { access: 'a1', refresh: 'r1', expiresAt: f.now() + 3_600_000 });
  const seen: string[] = [];
  const out = await f.client.run(undefined, async access => {
    seen.push(access);
    if (access === 'a1') throw Object.assign(new Error('nope'), { status: 401 });
    return 'ok';
  });
  assert.equal(out, 'ok');
  assert.deepEqual(seen, ['a1', 'a2']);
  assert.equal(f.calls.length, 1);
  await assert.rejects(() => f.client.run(undefined, async () => { throw Object.assign(new Error('x'), { status: 403 }); }), (e: { status: number }) => e.status === 403);
  assert.equal(f.calls.length, 1);
  let attempts = 0;
  await assert.rejects(() => f.client.run(undefined, async () => { attempts += 1; throw Object.assign(new Error('x'), { status: 401 }); }), (e: { status: number }) => e.status === 401);
  assert.equal(attempts, 2);
});

test('importTokens adopts existing tokens and validates input', async t => {
  const f = await fixture(t, () => { throw new Error('unused'); });
  assert.deepEqual(await f.client.importTokens({ access: 'a', refresh: 'r', expiresAt: f.now() + 3_600_000, label: 'imported' }), { connected: true, account: { label: 'imported' } });
  assert.equal(await f.client.accessToken(), 'a');
  await assert.rejects(() => f.client.importTokens({ access: '', expiresAt: 1 }), (e: GrokError) => e.code === 'invalid-response');
  await assert.rejects(() => f.client.importTokens({ access: 'a', expiresAt: Number.NaN }), (e: GrokError) => e.code === 'invalid-response');
});

test('corrupt storage reports storage-unavailable and options are validated', async t => {
  const f = await fixture(t, () => { throw new Error('unused'); });
  f.setSaved('not json');
  await assert.rejects(() => f.client.status(), (e: GrokError) => e.code === 'storage-unavailable');
  assert.throws(() => createGrokClient({ appName: '', namespace: 'x' }), TypeError);
  assert.throws(() => createGrokClient({ appName: 'A', namespace: '../x' }), TypeError);
  assert.ok(new GrokError('declined').message.length > 0);
});
