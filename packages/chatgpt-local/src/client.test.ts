import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createChatGptClient, type ChatGptClientOptions } from '../dist/index.js';

async function fixture(t: { after(fn: () => unknown): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'byos-lifecycle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = await generateKeyPair('ES256'); const jwk = { ...await exportJWK(key.publicKey), kid: 'test', alg: 'ES256' };
  let saved: string | null = null; let clock = Date.now(); let authorization: URL;
  let release!: () => void; let refreshStarted!: () => void;
  const controls = { refreshes: 0, inference: 0, holdRefresh: false, holdInference: false, refreshError: '', omitReplacement: false, storeFailure: false, revokeFailure: false, exchanges: 0, authFailure: false, holdOpen: false, callbackClient: 'oaiapp_lifecycle', subject: 'subject-a', prompt: '', requestBody: {} as Record<string, unknown>, bodies: [] as URLSearchParams[] };
  const started = new Promise<void>(r => { refreshStarted = r; });
  const barrier = new Promise<void>(r => { release = r; });
  const options: ChatGptClientOptions = {
    appName: 'BYOS Test', namespace: 'byos-lifecycle-test', storageDirectory: directory, now: () => clock,
    credentialStore: { read: async () => saved, write: async value => { if (controls.storeFailure) throw new Error('synthetic-storage-secret'); saved = value; } },
    openBrowser: async url => {
      authorization = new URL(url); if (controls.holdOpen) return;
      controls.prompt = authorization.searchParams.get('prompt') ?? '';
      const callback = new URL(authorization.searchParams.get('redirect_uri')!);
      callback.searchParams.set('state', authorization.searchParams.get('state')!);
      callback.searchParams.set('code', 'fake-code'); callback.searchParams.set('client_id', controls.callbackClient);
      const received = await fetch(callback); assert.equal(received.status, 200); assert.match(await received.text(), /Authorization received/);
    },
    fetch: async (url, init) => {
      assert.equal(init?.redirect, 'error');
      const path = new URL(String(url)).pathname;
      if (path.endsWith('openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json', revocation_endpoint: 'https://auth.openai.com/oauth/revoke' });
      if (path.endsWith('jwks.json')) return Response.json({ keys: [jwk] });
      if (path.endsWith('/token')) {
        const form = new URLSearchParams(String(init?.body)); controls.bodies.push(form);
        assert.equal(form.get('resource'), 'https://api.openai.com/v1');
        if (form.get('grant_type') === 'refresh_token') {
          controls.refreshes++; refreshStarted(); if (controls.holdRefresh) await barrier;
          if (controls.refreshError) return Response.json({ error: controls.refreshError }, { status: controls.refreshError === 'server_error' ? 503 : 400 });
          return Response.json({ access_token: 'rotated-access', ...(controls.omitReplacement ? {} : { refresh_token: 'rotated-refresh' }), token_type: 'Bearer', expires_in: 3600 });
        }
        controls.exchanges++;
        assert.equal(createHash('sha256').update(form.get('code_verifier')!).digest('base64url'), authorization.searchParams.get('code_challenge'));
        assert.equal(form.get('redirect_uri'), authorization.searchParams.get('redirect_uri'));
        assert.equal(form.get('client_id'), controls.callbackClient);
        if (controls.authFailure) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        const id = await new SignJWT({ sub: controls.subject, email: 'same@example.test', nonce: authorization.searchParams.get('nonce') })
          .setIssuer('https://auth.openai.com').setAudience(controls.callbackClient).setIssuedAt(Math.floor(clock / 1000)).setExpirationTime(Math.floor(clock / 1000) + 3600)
          .setProtectedHeader({ alg: 'ES256', kid: 'test' }).sign(key.privateKey);
        return Response.json({ access_token: 'first-access', refresh_token: 'first-refresh', id_token: id, token_type: 'Bearer', expires_in: 3600, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' });
      }
      if (path.endsWith('/revoke')) return new Response(null, { status: controls.revokeFailure ? 503 : 200 });
      if (path.endsWith('/models')) return Response.json({ models: [{ slug: 'test-model', display_name: 'Test model', visibility: 'list' }] });
      if (path.endsWith('/responses')) {
        controls.inference++; if (controls.holdInference) { refreshStarted(); await barrier; } controls.requestBody = JSON.parse(String(init?.body));
        const stream = `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"draft":true}' }] }] } })}\r\n\r\n`;
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      throw new Error('Unexpected endpoint');
    },
  };
  return { client: createChatGptClient(options), another: () => createChatGptClient(options), controls, directory, stored: () => saved, advance: () => { clock += 3_550_000; }, started, release, authorization: () => authorization, externalLifecycleChange: () => { const value = JSON.parse(saved!); value.revision++; saved = JSON.stringify(value); } };
}

test('native-runtime flow persists registration, discovers models and accepts only completed drafts', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.client.status(), { connected: false, planEnabled: false });
  const status = await f.client.signIn({ enablePlan: true });
  assert.equal(status.connected, true); assert.equal(status.planEnabled, true); assert.equal(f.controls.prompt, 'consent');
  assert.deepEqual(await f.another().status(), status);
  assert.deepEqual(await f.client.listModels(), [{ id: 'test-model', name: 'Test model' }]);
  const progress: unknown[] = [];
  assert.deepEqual(await f.client.generate({ model: 'test-model', input: 'Draft', instructions: 'JSON only', onProgress: value => progress.push(value) }), { text: '{"draft":true}' });
  assert.deepEqual(progress, [{ phase: 'receiving', outputChars: 14 }]);
  assert.equal(f.controls.requestBody.store, false); assert.equal(f.controls.requestBody.stream, true);
  assert.equal(f.controls.requestBody.instructions, 'JSON only'); assert.ok(Array.isArray(f.controls.requestBody.input));
  assert.ok(!JSON.stringify(status).includes('first-access'));
  assert.deepEqual(await readdir(f.directory), [], 'Lock directory contains no credentials or leftover locks');
});

test('separate instances serialize refresh rotation and persist latest complete record', async t => {
  const f = await fixture(t); await f.client.signIn(); f.advance(); f.controls.holdRefresh = true;
  const one = f.client.listModels(); await f.started;
  const two = f.another().listModels(); f.release(); await Promise.all([one, two]);
  assert.equal(f.controls.refreshes, 1); assert.ok(f.stored()!.includes('rotated-refresh')); assert.ok(!f.stored()!.includes('first-refresh'));
});

test('canceling one waiter does not lose rotating refresh needed by another', async t => {
  const f = await fixture(t); await f.client.signIn(); f.advance(); f.controls.holdRefresh = true;
  const abort = new AbortController(); const one = f.client.listModels(abort.signal);
  const rejected = assert.rejects(one, { code: 'canceled' }); await f.started;
  const two = f.another().listModels(); abort.abort(); f.release(); await rejected; await two;
  assert.equal(f.controls.refreshes, 1); assert.ok(f.stored()!.includes('rotated-refresh'));
});

test('disconnect waits for rotation, revokes replacement, and cannot resurrect tokens', async t => {
  const f = await fixture(t); await f.client.signIn(); f.advance(); f.controls.holdRefresh = true;
  const operation = f.client.listModels(); const rejected = assert.rejects(operation, { code: 'canceled' }); await f.started;
  const disconnect = f.another().disconnect(); f.release(); await rejected; assert.deepEqual(await disconnect, { revoked: true });
  assert.equal((await f.client.status()).connected, false); assert.ok(!f.stored()!.includes('rotated-refresh'));
  const accounts = await f.client.accounts(); assert.equal(accounts.length, 1); assert.equal(accounts[0].connected, false);
});

for (const kind of ['invalid_grant', 'server_error', 'missing-replacement']) {
  test(`refresh recovery: ${kind}`, async t => {
    const f = await fixture(t); await f.client.signIn(); f.advance();
    f.controls.refreshError = kind === 'missing-replacement' ? '' : kind; f.controls.omitReplacement = kind === 'missing-replacement';
    await assert.rejects(f.client.listModels(), { code: kind === 'server_error' ? 'unavailable' : 'reconnect-required' });
    assert.equal((await f.client.status()).connected, kind === 'server_error');
    assert.equal((await f.client.accounts()).length, 1);
  });
}

test('unconfirmed remote revocation clears local tokens and retains client/host for reconnect', async t => {
  const f = await fixture(t); const first = await f.client.signIn(); const host = f.authorization().searchParams.get('ext_agent_host_id');
  f.controls.revokeFailure = true; assert.deepEqual(await f.client.disconnect(), { revoked: false });
  await f.client.signIn({ accountId: first.account!.id });
  assert.equal(f.authorization().searchParams.get('client_id'), 'oaiapp_lifecycle');
  assert.equal(f.authorization().searchParams.get('ext_agent_host_id'), host);
  assert.equal(f.authorization().searchParams.has('agent_name_hint'), false);
  assert.equal(f.authorization().searchParams.has('id_token_hint'), false);
});

test('invalid grant retains pending issued registration for a returning sign-in', async t => {
  const f = await fixture(t); f.controls.authFailure = true;
  await assert.rejects(f.client.signIn(), { code: 'auth-failed' });
  const accounts = await f.client.accounts(); assert.equal(accounts.length, 1); assert.equal(accounts[0].connected, false);
  f.controls.authFailure = false; await f.client.signIn({ accountId: accounts[0].id });
  assert.equal(f.authorization().searchParams.get('client_id'), 'oaiapp_lifecycle');
});

test('registrations with identical email remain separate and selectable', async t => {
  const f = await fixture(t); const first = await f.client.signIn();
  f.controls.callbackClient = 'oaiapp_second'; f.controls.subject = 'subject-b'; const second = await f.client.signIn();
  assert.notEqual(first.account!.id, second.account!.id); assert.notEqual(first.account!.label, second.account!.label);
  assert.equal((await f.client.accounts()).length, 2);
  assert.equal((await f.client.selectAccount(first.account!.id)).account!.id, first.account!.id);
});

test('protected-store failure is redacted and never falls back to a file', async t => {
  const f = await fixture(t); f.controls.storeFailure = true;
  await assert.rejects(f.client.signIn(), error => (error as Error).message.indexOf('synthetic-storage-secret') < 0 && (error as { code: string }).code === 'storage-unavailable');
  assert.deepEqual(await readdir(f.directory), []); assert.equal(f.stored(), null); assert.equal(f.controls.exchanges, 0);
});

test('canceling pending browser authorization closes listener and saves no tokens', async t => {
  const f = await fixture(t); f.controls.holdOpen = true; const abort = new AbortController();
  const signIn = f.client.signIn({ signal: abort.signal }); const rejected = assert.rejects(signIn, { code: 'canceled' });
  while (!f.authorization()) await new Promise(resolve => setTimeout(resolve, 5));
  const callback = f.authorization().searchParams.get('redirect_uri')!; abort.abort(); await rejected;
  await assert.rejects(fetch(callback)); assert.equal((await f.client.status()).connected, false);
});


test('a different process lifecycle change rejects a completed old-account request', async t => {
  const f = await fixture(t); await f.client.signIn(); f.controls.holdInference = true;
  const output = f.client.generate({ model: 'test-model', input: 'Draft' }); const rejected = assert.rejects(output, { code: 'canceled' });
  await f.started; f.externalLifecycleChange(); f.release(); await rejected;
});

test('a different process sign-out prevents pending authorization from activating', async t => {
  const f = await fixture(t); f.controls.holdOpen = true;
  const pending = f.client.signIn(); const rejected = assert.rejects(pending, { code: 'canceled' });
  while (!f.authorization()) await new Promise(resolve => setTimeout(resolve, 5));
  f.externalLifecycleChange();
  const callback = new URL(f.authorization().searchParams.get('redirect_uri')!);
  callback.searchParams.set('state', f.authorization().searchParams.get('state')!);
  callback.searchParams.set('code', 'fake-code'); callback.searchParams.set('client_id', 'oaiapp_lifecycle');
  await fetch(callback); await rejected;
  assert.equal((await f.client.status()).connected, false); assert.equal(f.controls.exchanges, 0);
});
