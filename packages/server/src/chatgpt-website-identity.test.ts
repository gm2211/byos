import test from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { ChatGptWebsiteIdentityError, createChatGptWebsiteIdentity, type ChatGptWebsiteTransaction } from './chatgpt-website-identity.ts';

const CLIENT_ID = 'oaiapp_syntheticapprovedclient';
const REDIRECT = 'https://app.example.test/auth/chatgpt/callback';
const BINDING = 'browser-binding-synthetic-0123456789abcdef';
const NOW = 1_800_000_000_000;
const NOW_SECONDS = Math.floor(NOW / 1000);
const KEY_ID = 'synthetic-key';
const DISCOVERY = { issuer: 'https://auth.openai.com', authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize', token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json', id_token_signing_alg_values_supported: ['RS256'] };

class MemoryTransactions {
  values = new Map<string, ChatGptWebsiteTransaction>();
  async put(binding: string, transaction: ChatGptWebsiteTransaction) { this.values.set(binding, transaction); }
  async consume(binding: string) {
    const transaction = this.values.get(binding);
    this.values.delete(binding);
    return transaction;
  }
}

type TokenClaims = { iss?: string; aud?: string | string[]; azp?: string; nonce?: string; sub?: string; exp?: number; iat?: number; email?: string; email_verified?: boolean; name?: string; picture?: string };
async function signedToken(key: KeyLike, claims: TokenClaims = {}) {
  const builder = new SignJWT({
    sub: claims.sub ?? 'openai-subject-synthetic',
    nonce: claims.nonce ?? '',
    ...(claims.azp ? { azp: claims.azp } : {}),
    ...(claims.email ? { email: claims.email } : {}),
    ...(claims.email_verified !== undefined ? { email_verified: claims.email_verified } : {}),
    ...(claims.name ? { name: claims.name } : {}),
    ...(claims.picture ? { picture: claims.picture } : {}),
  }).setProtectedHeader({ alg: 'RS256', kid: KEY_ID });
  builder.setIssuer(claims.iss ?? 'https://auth.openai.com');
  builder.setAudience(claims.aud ?? CLIENT_ID);
  builder.setIssuedAt(claims.iat ?? NOW_SECONDS);
  builder.setExpirationTime(claims.exp ?? NOW_SECONDS + 300);
  return builder.sign(key);
}

async function fixture(options: { claims?: TokenClaims; wrongSignature?: boolean; failingEndpoint?: string; tokenResponse?: unknown } = {}) {
  const signing = await generateKeyPair('RS256');
  const wrongSigning = options.wrongSignature ? await generateKeyPair('RS256') : signing;
  const jwk = await exportJWK(signing.publicKey);
  jwk.kid = KEY_ID; jwk.alg = 'RS256'; jwk.use = 'sig';
  const transactions = new MemoryTransactions();
  let now = NOW;
  const calls: string[] = [];
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let issuedNonce = '';
  const client = createChatGptWebsiteIdentity({
    clientId: CLIENT_ID, redirectUri: REDIRECT, transactions, now: () => now,
    fetch: async (input, init) => {
      const url = String(input);
      calls.push(url);
      requests.push({ url, init });
      if (options.failingEndpoint === url) throw new Error('synthetic network failure with secret-bearing details');
      if (url === 'https://auth.openai.com/.well-known/openid-configuration') return Response.json(DISCOVERY);
      if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
        const idToken = await signedToken(wrongSigning.privateKey, { ...options.claims, nonce: options.claims?.nonce ?? issuedNonce });
        return Response.json(options.tokenResponse ?? {
          id_token: idToken,
          access_token: 'SYNTHETIC-ACCESS-DO-NOT-RETURN',
          refresh_token: 'SYNTHETIC-REFRESH-DO-NOT-RETURN',
        });
      }
      if (url === 'https://auth.openai.com/.well-known/jwks.json') return Response.json({ keys: [jwk] });
      throw new Error(`Unexpected destination: ${url}`);
    },
  });
  const { authorizationUrl } = await client.begin(BINDING);
  issuedNonce = transactions.values.get(BINDING)!.nonce;
  const authorization = new URL(authorizationUrl);
  return {
    client, transactions, authorization, calls, requests,
    setNow(value: number) { now = value; },
    callback(state = authorization.searchParams.get('state')!, extras = '') {
      return `${REDIRECT}?state=${encodeURIComponent(state)}&code=synthetic-authorization-code${extras}`;
    },
  };
}

test('website identity remains disabled until an approved client and exact callback are configured', async () => {
  const disabled = createChatGptWebsiteIdentity({ transactions: new MemoryTransactions() });
  assert.equal(disabled.enabled, false);
  await assert.rejects(disabled.begin(BINDING), error => error instanceof ChatGptWebsiteIdentityError && error.code === 'not_configured');
  assert.throws(() => createChatGptWebsiteIdentity({ clientId: 'not-an-openai-client', redirectUri: REDIRECT, transactions: new MemoryTransactions() }), /provisioned/);
  assert.throws(() => createChatGptWebsiteIdentity({ clientId: CLIENT_ID, redirectUri: 'http://app.example.test/callback', transactions: new MemoryTransactions() }), /HTTPS/);
  assert.throws(() => createChatGptWebsiteIdentity({ clientId: CLIENT_ID, redirectUri: 'https://user@app.example.test/callback', transactions: new MemoryTransactions() }), /HTTPS/);
});

test('authorization uses identity-only scope, server PKCE transaction, and fixed OpenAI endpoint', async () => {
  const transactions = new MemoryTransactions();
  const client = createChatGptWebsiteIdentity({ clientId: CLIENT_ID, redirectUri: REDIRECT, transactions, now: () => NOW, fetch: async input => { assert.equal(String(input), 'https://auth.openai.com/.well-known/openid-configuration'); return Response.json(DISCOVERY); } });
  const { authorizationUrl } = await client.begin(BINDING);
  const url = new URL(authorizationUrl);
  assert.equal(url.origin, 'https://auth.openai.com');
  assert.equal(url.pathname, '/api/accounts/authorize');
  assert.equal(url.searchParams.get('scope'), 'openid profile email');
  assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(url.searchParams.get('code_challenge')!, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(url.searchParams.get('state'));
  assert.ok(url.searchParams.get('nonce'));
  const tx = transactions.values.get(BINDING)!;
  assert.equal(tx.expiresAt, NOW + 10 * 60 * 1000);
  assert.notEqual(tx.codeVerifier, url.searchParams.get('code_challenge'));
});

test('discovery metadata mismatch fails closed before storing a transaction', async () => {
  const transactions = new MemoryTransactions();
  const client = createChatGptWebsiteIdentity({
    clientId: CLIENT_ID, redirectUri: REDIRECT, transactions,
    fetch: async input => {
      assert.equal(String(input), 'https://auth.openai.com/.well-known/openid-configuration');
      return Response.json({ ...DISCOVERY, token_endpoint: 'https://attacker.example/token' });
    },
  });
  await assert.rejects(client.begin(BINDING), /could not be completed/);
  assert.equal(transactions.values.size, 0);
});

test('callback returns only verified identity and never exposes OAuth access or refresh tokens', async () => {
  const f = await fixture({ claims: { email: 'buyer@example.test', name: 'Synthetic Buyer', email_verified: true } });
  const identity = await f.client.complete(BINDING, f.callback());
  assert.deepEqual(identity, {
    issuer: 'https://auth.openai.com', clientId: CLIENT_ID, subject: 'openai-subject-synthetic',
    email: 'buyer@example.test', emailVerified: true, name: 'Synthetic Buyer',
  });
  assert.equal('accessToken' in identity, false);
  assert.equal('refreshToken' in identity, false);
  assert.equal('idToken' in identity, false);
  assert.doesNotMatch(JSON.stringify(identity), /SYNTHETIC-(ACCESS|REFRESH)/);
  assert.deepEqual(f.calls, [
    'https://auth.openai.com/.well-known/openid-configuration',
    'https://auth.openai.com/api/accounts/oauth/token',
    'https://auth.openai.com/.well-known/jwks.json',
  ]);
  const request = f.requests[1].init!;
  assert.equal(request.redirect, 'error');
  assert.equal(request.headers instanceof Object && new Headers(request.headers).has('authorization'), false);
  const body = new URLSearchParams(String(request.body));
  assert.equal(body.get('client_id'), CLIENT_ID);
  assert.equal(body.get('redirect_uri'), REDIRECT);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.ok(body.get('code_verifier'));
  assert.equal(body.has('client_secret'), false);
});

test('callback consumes state atomically and rejects wrong browser, wrong state, replay, expiry, and callback URL', async () => {
  const wrongBrowser = await fixture();
  await assert.rejects(wrongBrowser.client.complete('another-browser-binding-0123456789', wrongBrowser.callback()), /could not be completed/);
  assert.deepEqual(wrongBrowser.calls, ['https://auth.openai.com/.well-known/openid-configuration']);

  const wrongState = await fixture();
  await assert.rejects(wrongState.client.complete(BINDING, wrongState.callback('attacker-state')), /could not be completed/);
  assert.equal(wrongState.transactions.values.has(BINDING), false);
  assert.deepEqual(wrongState.calls, ['https://auth.openai.com/.well-known/openid-configuration']);

  const replay = await fixture();
  const callback = replay.callback();
  await replay.client.complete(BINDING, callback);
  await assert.rejects(replay.client.complete(BINDING, callback), /could not be completed/);
  assert.equal(replay.calls.length, 3);

  const expired = await fixture();
  expired.setNow(NOW + 10 * 60 * 1000);
  await assert.rejects(expired.client.complete(BINDING, expired.callback()), /could not be completed/);
  assert.deepEqual(expired.calls, ['https://auth.openai.com/.well-known/openid-configuration']);

  const wrongUrl = await fixture();
  await assert.rejects(wrongUrl.client.complete(BINDING, `https://evil.example.test/auth/chatgpt/callback?${new URL(wrongUrl.callback()).searchParams}`), /could not be completed/);
  assert.equal(wrongUrl.transactions.values.has(BINDING), true);
  assert.deepEqual(wrongUrl.calls, ['https://auth.openai.com/.well-known/openid-configuration']);
});

test('callback rejects OIDC issuer, audience, signature, subject, and nonce mismatches', async t => {
  const cases = [
    { name: 'issuer', options: { claims: { iss: 'https://attacker.example' } } },
    { name: 'audience', options: { claims: { aud: 'oaiapp_otherclient' } } },
    { name: 'signature', options: { wrongSignature: true } },
    { name: 'subject', options: { claims: { sub: '' } } },
    { name: 'nonce', options: { claims: { nonce: 'wrong-nonce' } } },
    { name: 'authorized party', options: { claims: { azp: 'oaiapp_otherclient' } } },
    { name: 'future issued-at', options: { claims: { iat: NOW_SECONDS + 60 } } },
    { name: 'expiry', options: { claims: { exp: 1 } } },
  ] as const;
  for (const item of cases) await t.test(item.name, async () => {
    const f = await fixture(item.options);
    await assert.rejects(f.client.complete(BINDING, f.callback()), /could not be completed/);
  });
});

test('callback uses bounded fixed destinations, handles cancellation, and redacts network/token errors', async () => {
  const canceled = await fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(canceled.client.complete(BINDING, canceled.callback(), controller.signal), /could not be completed/);
  assert.equal(canceled.calls.length, 1);

  const network = await fixture({ failingEndpoint: 'https://auth.openai.com/api/accounts/oauth/token' });
  await assert.rejects(network.client.complete(BINDING, network.callback()), error => {
    assert.ok(error instanceof ChatGptWebsiteIdentityError);
    assert.equal(error.code, 'sign_in_failed');
    assert.equal((error as Error).message, 'Sign in with ChatGPT could not be completed. Start again.');
    assert.doesNotMatch((error as Error).message, /secret-bearing/);
    return true;
  });

  const malformed = await fixture({ tokenResponse: { access_token: 'SYNTHETIC-ACCESS-DO-NOT-RETURN' } });
  await assert.rejects(malformed.client.complete(BINDING, malformed.callback()), /could not be completed/);
  assert.deepEqual(malformed.calls, ['https://auth.openai.com/.well-known/openid-configuration', 'https://auth.openai.com/api/accounts/oauth/token']);
});
