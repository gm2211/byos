import assert from 'node:assert/strict';
import test from 'node:test';
// Built output: sources use NodeNext `.js` imports.
import { endpointFor, huggingface, createHuggingFaceSignIn } from '../dist/index.js';

type Call = { url: string; init?: RequestInit };
function fakeFetch(respond: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return calls;
}

/** Minimal in-memory Storage + crypto/BroadcastChannel stand-ins, since these tests run under
 * plain Node (node:test), not a browser or jsdom. */
function installBrowserGlobals(): void {
  class MemoryStorage {
    private store = new Map<string, string>();
    getItem(key: string): string | null { return this.store.has(key) ? this.store.get(key)! : null; }
    setItem(key: string, value: string): void { this.store.set(key, value); }
    removeItem(key: string): void { this.store.delete(key); }
    clear(): void { this.store.clear(); }
  }
  (globalThis as unknown as { sessionStorage: unknown }).sessionStorage = new MemoryStorage();
  (globalThis as unknown as { localStorage: unknown }).localStorage = new MemoryStorage();
  (globalThis as unknown as { window: unknown }).window = {
    location: { hash: '', origin: 'https://motive.example', pathname: '/', assign: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}
installBrowserGlobals();

// Each call gets its own storage keys so tests sharing the module-level localStorage/sessionStorage
// stand-ins (installed once, above) never see another test's stored token or transaction.
let signInCounter = 0;
function makeSignIn() {
  const id = ++signInCounter;
  return createHuggingFaceSignIn({
    clientId: 'https://motive.example/.well-known/oauth-cimd',
    redirectUri: 'https://motive.example/oauth/callback/huggingface',
    tokenStorageKey: `test-hf-token-${id}`,
    transactionStorageKey: `test-hf-pkce-${id}`,
    handoffChannel: `test-hf-oauth-${id}`,
    handoffFallbackKey: `test-hf-oauth-handoff-${id}`,
  });
}

test('endpointFor: Hugging Face is OpenAI-compatible with no server-side search', () => {
  const endpoint = endpointFor('huggingface', 'hf_secret');
  assert.equal(endpoint.baseUrl, 'https://router.huggingface.co/v1');
  assert.equal(endpoint.apiKey, 'hf_secret');
  assert.equal(endpoint.webSearch, 'none');
});

test('huggingface(): PKCE sign-in is offered only with a clientId; paste-token is always there', () => {
  assert.deepEqual(huggingface().signIn.map(m => m.kind), ['api-key']);
  assert.deepEqual(huggingface({ clientId: 'id' }).signIn.map(m => m.kind), ['pkce', 'api-key']);
  assert.equal(huggingface({ clientId: 'id' }).signIn[0].handshakeViaSite, false);
});

test('huggingface() model discovery and streaming reuse the shared kit machinery', async () => {
  const calls = fakeFetch(() => new Response(JSON.stringify({ data: [{ id: 'meta-llama/x', name: 'Llama X' }] })));
  assert.deepEqual(await huggingface().listModels('hf_secret'), [{ id: 'meta-llama/x', name: 'Llama X' }]);
  assert.equal(calls[0].url, 'https://router.huggingface.co/v1/models');
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, 'Bearer hf_secret');
});

test('authorize URL carries a fresh state and an S256 PKCE challenge', async () => {
  const signIn = makeSignIn();
  const verifier = 'a'.repeat(64);
  const challenge = await signIn.challengeFor(verifier);
  const url = new URL(await signIn.buildAuthorizeUrl('state-123', challenge));
  assert.equal(url.origin + url.pathname, 'https://huggingface.co/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'https://motive.example/.well-known/oauth-cimd');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://motive.example/oauth/callback/huggingface');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), 'state-123');
  assert.equal(url.searchParams.get('code_challenge'), challenge);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), 'openid profile inference-api');
  // The challenge is a SHA-256 digest of the verifier, not the verifier itself.
  assert.notEqual(challenge, verifier);
});

test('complete() rejects a callback whose state does not match the stored transaction', async () => {
  const signIn = makeSignIn();
  await signIn.storeTransaction({ verifier: 'v'.repeat(64), state: 'expected-state', createdAt: Date.now(), returnRoute: '#explore' });
  await assert.rejects(
    () => signIn.complete('some-code', 'wrong-state'),
    (error: Error) => error.message.includes('could not be verified'),
  );
  // The mismatch clears the transaction so a retried callback can't reuse it either.
  assert.equal(sessionStorage.getItem('test-hf-pkce'), null);
});

test('complete() exchanges the code at HF\'s token endpoint using the stored verifier, and stores expiry', async () => {
  const signIn = makeSignIn();
  await signIn.storeTransaction({ verifier: 'the-verifier', state: 'good-state', createdAt: Date.now(), returnRoute: '#explore' });
  const calls = fakeFetch(() => new Response(JSON.stringify({ access_token: 'hf_new_token', expires_in: 3600, refresh_token: 'r1' })));
  const before = Date.now();
  const token = await signIn.complete('the-code', 'good-state');
  assert.equal(token.accessToken, 'hf_new_token');
  assert.equal(token.refreshToken, 'r1');
  assert.ok(token.expiresAt >= before + 3600 * 1000);
  assert.equal(calls[0].url, 'https://huggingface.co/oauth/token');
  assert.equal(calls[0].init?.headers && (calls[0].init.headers as Record<string, string>)['Content-Type'], 'application/x-www-form-urlencoded');
  const body = new URLSearchParams(String(calls[0].init?.body));
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'the-code');
  assert.equal(body.get('code_verifier'), 'the-verifier');
  assert.equal(body.get('client_id'), 'https://motive.example/.well-known/oauth-cimd');
  // The exchanged token is now the stored connection.
  assert.deepEqual(signIn.getStoredToken(), token);
});

test('refresh() uses the stored refresh_token and clears the connection when there is none to use', async () => {
  const signIn = makeSignIn();
  await assert.rejects(() => signIn.refresh(), (error: Error) => error.message.includes('Sign in again'));

  signIn.storeToken({ accessToken: 'stale', expiresAt: Date.now() - 1000, refreshToken: 'r1' });
  fakeFetch(() => new Response(JSON.stringify({ access_token: 'fresh', expires_in: 60 })));
  const refreshed = await signIn.refresh();
  assert.equal(refreshed.accessToken, 'fresh');
  assert.equal(signIn.getStoredToken()?.accessToken, 'fresh');
});
