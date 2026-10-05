import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createChatGptClient } from '../dist/index.js';

// Entire fixture uses synthetic credentials and an ephemeral local callback.
async function securityHarness(t: { after(fn: () => unknown): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'byos-security-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(key.publicKey), kid: 'security-test', alg: 'RS256', use: 'sig' };
  let record: string | null = null;
  let authorization: URL;
  const state = {
    claims: {} as Record<string, unknown>,
    scope: 'openid email profile offline_access resource.invoke chatgpt.tokens.use.direct',
    callbackClient: 'oaiapp_security_test',
    callbackMutation: undefined as undefined | ((callback: URL) => void),
    stream: 'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Synthetic complete draft"}]}]}}\n\n',
    responseStatus: 200,
    responseBody: '',
    models: [{ slug: 'security-model', display_name: 'Security Model', visibility: 'list' }] as Record<string, unknown>[],
    discoveryJwks: 'https://auth.openai.com/.well-known/jwks.json',
    unknownKey: false,
    badSignature: false,
    callbackResponse: undefined as Promise<Response> | undefined,
    tokenRequests: 0,
    requests: [] as { url: string; init?: RequestInit }[],
  };
  const client = createChatGptClient({
    appName: 'BYOS Security Test', namespace: 'byos-security-test', storageDirectory: directory,
    credentialStore: { read: async () => record, write: async value => { record = value; } },
    openBrowser: async value => {
      authorization = new URL(value);
      assert.equal(authorization.origin, 'https://auth.openai.com');
      assert.equal(authorization.searchParams.has('id_token_hint'), false, 'No credential may enter a subprocess opener URL');
      const callback = new URL(authorization.searchParams.get('redirect_uri')!);
      assert.equal(callback.hostname, '127.0.0.1');
      assert.equal(callback.pathname, '/auth/callback');
      callback.searchParams.set('state', authorization.searchParams.get('state')!);
      callback.searchParams.set('code', 'synthetic-authorization-code');
      callback.searchParams.set('client_id', state.callbackClient);
      state.callbackMutation?.(callback);
      state.callbackResponse = fetch(callback);
      await state.callbackResponse;
    },
    fetch: async (input, init) => {
      const url = String(input);
      state.requests.push({ url, init });
      if (url.endsWith('/.well-known/openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com', jwks_uri: state.discoveryJwks, revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke' });
      if (url.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [jwk] });
      if (url.endsWith('/oauth/token')) {
        state.tokenRequests++;
        let idToken = await new SignJWT({ sub: 'synthetic-subject', nonce: authorization.searchParams.get('nonce'),
          iss: 'https://auth.openai.com', aud: 'oaiapp_security_test', exp: Math.floor(Date.now()/1000)+3600,
          iat: Math.floor(Date.now()/1000), email: 'synthetic@example.test', ...state.claims })
          .setProtectedHeader({ alg: 'RS256', kid: state.unknownKey ? 'unknown-key' : 'security-test' }).sign(key.privateKey);
        if (state.badSignature) {
          const parts = idToken.split('.');
          const signature = Buffer.from(parts[2]!, 'base64url'); signature[0] = signature[0]! ^ 1;
          parts[2] = signature.toString('base64url'); idToken = parts.join('.');
        }
        return Response.json({ access_token: 'synthetic-access-token', refresh_token: 'synthetic-refresh-token', id_token: idToken,
          token_type: 'Bearer', expires_in: 3600, scope: state.scope });
      }
      if (url.endsWith('/models')) return Response.json({ models: state.models });
      if (url.endsWith('/responses')) return new Response(state.responseStatus === 200 ? state.stream : state.responseBody,
        { status: state.responseStatus, headers: { 'content-type': state.responseStatus === 200 ? 'text/event-stream' : 'application/json' } });
      if (url.endsWith('/oauth/revoke')) return new Response(null, { status: 200 });
      throw new Error('Unexpected fixture endpoint');
    },
  });
  return { client, state, stored: () => record };
}

for (const [name, claims] of [
  ['nonce', { nonce: 'different-nonce' }],
  ['issuer', { iss: 'https://attacker.example' }],
  ['audience', { aud: 'oaiapp_other' }],
  ['expiration', { exp: 1 }],
  ['missing subject', { sub: '' }],
] as const) {
  test(`rejects a correctly signed ID token with invalid ${name}`, async t => {
    const h = await securityHarness(t);
    h.state.claims = claims;
    await assert.rejects(h.client.signIn());
    assert.equal(h.state.tokenRequests, 1, 'Must reach ID-token validation, not fail on local callback setup');
    assert.equal((await h.client.status()).connected, false);
    assert.equal(h.stored()?.includes('synthetic-access-token') ?? false, false);
  });
}

test('rejects unknown signing key and foreign JWKS discovery destinations', async t => {
  const h = await securityHarness(t);
  h.state.unknownKey = true;
  await assert.rejects(h.client.signIn());
  assert.equal(h.state.tokenRequests, 1);
  h.state.unknownKey = false;
  h.state.discoveryJwks = 'https://attacker.example/jwks.json';
  await assert.rejects(h.client.signIn());
  assert.equal(h.state.requests.some(request => request.url.includes('attacker.example')), false);
  assert.equal((await h.client.status()).connected, false);
});

test('rejects an invalid signature even when key ID and identity claims match', async t => {
  const h = await securityHarness(t);
  h.state.badSignature = true;
  await assert.rejects(h.client.signIn());
  assert.equal(h.state.tokenRequests, 1);
  assert.equal((await h.client.status()).connected, false);
});

test('model picker includes only explicitly listed models in provider order', async t => {
  const h = await securityHarness(t);
  await h.client.signIn();
  const callbackResponse = await h.state.callbackResponse!;
  assert.equal(callbackResponse.status, 200);
  assert.match(await callbackResponse.text(), /Return to the app/);
  h.state.models = [
    { slug: 'hidden', visibility: 'hide' },
    { slug: 'unclassified' },
    { slug: 'internal', visibility: 'internal' },
    { slug: 'second', display_name: 'Second', visibility: 'list' },
    { slug: 'first', display_name: 'First', visibility: 'list' },
  ];
  assert.deepEqual(await h.client.listModels(), [{ id: 'second', name: 'Second' }, { id: 'first', name: 'First' }]);
});

test('returning sign-in rejects another issued client ID without replacing credentials', async t => {
  const h = await securityHarness(t);
  await h.client.signIn();
  const before = h.stored();
  const accountId = (await h.client.status()).account!.id;
  h.state.callbackClient = 'oaiapp_other';
  await assert.rejects(h.client.signIn({ accountId }));
  assert.equal(h.state.tokenRequests, 1);
  assert.equal(h.stored(), before);
});

for (const [name, mutate] of [
  ['missing state', (url: URL) => url.searchParams.delete('state')],
  ['wrong state', (url: URL) => url.searchParams.set('state', 'not-the-issued-state')],
  ['duplicate state', (url: URL) => url.searchParams.append('state', url.searchParams.get('state')!)],
  ['missing registration client', (url: URL) => url.searchParams.delete('client_id')],
  ['placeholder registration client', (url: URL) => url.searchParams.set('client_id', 'dynamic_agent_client')],
  ['denied consent with code present', (url: URL) => url.searchParams.set('error', 'access_denied')],
] as const) {
  test(`rejects callback ${name} before code exchange`, async t => {
    const h = await securityHarness(t);
    h.state.callbackMutation = mutate;
    await assert.rejects(h.client.signIn());
    assert.equal(h.state.tokenRequests, 0);
    assert.equal((await h.client.status()).connected, false);
  });
}

test('returning sign-in rejects changed subject even with same email', async t => {
  const h = await securityHarness(t);
  await h.client.signIn();
  const before = h.stored();
  h.state.claims = { sub: 'another-subject' };
  await assert.rejects(h.client.signIn({ accountId: (await h.client.status()).account!.id }));
  assert.equal(h.stored(), before);
});

test('identity-only sign-in cannot generate using callback claims of plan permission', async t => {
  const h = await securityHarness(t);
  h.state.scope = 'openid email profile';
  h.state.callbackMutation = callback => callback.searchParams.set('scope', 'chatgpt.tokens.use.direct');
  await h.client.signIn();
  assert.equal((await h.client.status()).connected, true);
  assert.equal((await h.client.status()).planEnabled, false);
  await assert.rejects(h.client.generate({ model: 'security-model', input: 'Synthetic prompt' }));
  assert.equal(h.state.requests.some(request => request.url.endsWith('/responses')), false);
});

for (const [name, suffix] of [
  ['truncated stream', ''],
  ['DONE marker without terminal response', 'data: [DONE]\n\n'],
  ['late response failure', 'data: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"synthetic-access-token"}}}\n\n'],
] as const) {
  test(`partial output is not success: ${name}`, async t => {
    const h = await securityHarness(t);
    await h.client.signIn();
    h.state.stream = 'data: {"type":"response.output_text.delta","delta":"Partial draft"}\n\n' + suffix;
    await assert.rejects(h.client.generate({ model: 'security-model', input: 'Synthetic prompt' }), error => {
      assert.equal(String(error).includes('synthetic-access-token'), false);
      return true;
    });
  });
}

test('provider errors do not disclose body contents and credential-bearing fetches reject redirects', async t => {
  const h = await securityHarness(t);
  await h.client.signIn();
  h.state.responseStatus = 403;
  h.state.responseBody = JSON.stringify({ detail: 'synthetic-access-token synthetic-refresh-token private prompt' });
  await assert.rejects(h.client.generate({ model: 'security-model', input: 'Synthetic prompt' }), error => {
    assert.doesNotMatch(String(error), /synthetic-access-token|synthetic-refresh-token|private prompt/);
    return true;
  });
  for (const request of h.state.requests.filter(request => request.url.endsWith('/oauth/token') || request.url.endsWith('/responses'))) {
    assert.equal(request.init?.redirect, 'error', request.url);
  }
});
