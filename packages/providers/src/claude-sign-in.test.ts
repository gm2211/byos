// Built output: the sources use NodeNext `.js` imports, so tests run against dist/.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginClaudeSignIn,
  claude,
  claudeNeedsRefresh,
  ClaudeAuthError,
  ClaudeReconnectRequiredError,
  claudeTokenRelayFetch,
  completeClaudeSignIn,
  decodeClaudeCredential,
  encodeClaudeCredential,
  refreshClaudeCredential,
  type ClaudeTokenFetch,
} from '../dist/index.js';
import { CLAUDE_CODE_SYSTEM_PREFIX, CLAUDE_OAUTH_BETA, CLAUDE_PASTE_REDIRECT_URI, CLAUDE_TOKEN_URL } from '@byos/core';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sse = (text: string) => new Response(`data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\n`, { status: 200 });

function tokenFetch(handler: (body: Record<string, unknown>, call: number) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const fetch: ClaudeTokenFetch = async (url, init) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, init, body });
    return handler(body, calls.length);
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

async function drain(iter: AsyncIterable<{ type: string; text?: string }>) {
  let text = '';
  for await (const event of iter) if (event.type === 'text') text += event.text;
  return text;
}

const messages = [{ role: 'system' as const, content: 'be brief' }, { role: 'user' as const, content: 'hi' }];
const credential = (overrides: Record<string, unknown> = {}) => encodeClaudeCredential({ accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 3_600_000, ...overrides } as never);

test('beginClaudeSignIn builds the claude.ai URL with S256 PKCE and a fresh attempt', async () => {
  const { url, attempt } = await beginClaudeSignIn(1_000);
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://claude.com/cai/oauth/authorize');
  assert.equal(parsed.searchParams.get('redirect_uri'), CLAUDE_PASTE_REDIRECT_URI);
  assert.equal(parsed.searchParams.get('state'), attempt.state);
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(attempt.verifier));
  const expected = Buffer.from(digest).toString('base64url');
  assert.equal(parsed.searchParams.get('code_challenge'), expected);
  assert.match(attempt.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(attempt.state, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(attempt.createdAt, 1_000);
  const second = await beginClaudeSignIn();
  assert.notEqual(second.attempt.verifier, attempt.verifier);
});

test('completeClaudeSignIn exchanges the pasted CODE#STATE and returns an encoded credential', async () => {
  const { attempt } = await beginClaudeSignIn();
  const { fetch, calls } = tokenFetch(() => json(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, account: { email_address: 'a@b.example' }, extra: 'ignored' }));
  const encoded = await completeClaudeSignIn(fetch, attempt, `  code-1#${attempt.state}  `);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CLAUDE_TOKEN_URL);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.deepEqual(calls[0].body, {
    grant_type: 'authorization_code', code: 'code-1', state: attempt.state, client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    redirect_uri: CLAUDE_PASTE_REDIRECT_URI, code_verifier: attempt.verifier,
  });
  const decoded = decodeClaudeCredential(encoded);
  assert.equal(decoded?.accessToken, 'at-1');
  assert.equal(decoded?.refreshToken, 'rt-1');
  assert.equal(decoded?.label, 'a@b.example');
  assert.ok(decoded && decoded.expiresAt > Date.now() + 3_500_000);
  assert.ok(encoded.startsWith('claude-subscription:'));
  // A bare code (no #STATE) works too.
  assert.ok(await completeClaudeSignIn(fetch, attempt, 'code-2'));
});

test('completeClaudeSignIn rejects bad pastes, wrong state, expired attempts and upstream failures with fixed text', async () => {
  const { attempt } = await beginClaudeSignIn(0);
  const never = tokenFetch(() => { throw new Error('must not be called'); });
  await assert.rejects(() => completeClaudeSignIn(never.fetch, attempt, '', undefined, 1_000), (e: Error) => e instanceof ClaudeAuthError && /did not match/.test(e.message));
  await assert.rejects(() => completeClaudeSignIn(never.fetch, attempt, 'code#WRONG', undefined, 1_000), ClaudeAuthError);
  await assert.rejects(() => completeClaudeSignIn(never.fetch, attempt, 'a b', undefined, 1_000), ClaudeAuthError);
  await assert.rejects(() => completeClaudeSignIn(never.fetch, attempt, 'code', undefined, 20 * 60_000 + 1), (e: Error) => /expired/.test(e.message));
  assert.equal(never.calls.length, 0);

  const secret = 'SECRET-UPSTREAM-TEXT';
  for (const status of [400, 401, 500]) {
    const failing = tokenFetch(() => json(status, { error: secret }));
    await assert.rejects(() => completeClaudeSignIn(failing.fetch, attempt, 'code', undefined, 1_000), (e: Error) => e instanceof ClaudeAuthError && !e.message.includes(secret) && (e as ClaudeAuthError).status === status);
  }
  const bad = tokenFetch(() => json(200, { refresh_token: 'rt' }));
  await assert.rejects(() => completeClaudeSignIn(bad.fetch, attempt, 'code', undefined, 1_000), ClaudeAuthError);
  const broken = tokenFetch(() => { throw new Error(secret); });
  await assert.rejects(() => completeClaudeSignIn(broken.fetch, attempt, 'code', undefined, 1_000), (e: Error) => e instanceof ClaudeAuthError && !e.message.includes(secret));
  const huge = tokenFetch(() => new Response('x'.repeat(70 * 1024), { status: 200 }));
  await assert.rejects(() => completeClaudeSignIn(huge.fetch, attempt, 'code', undefined, 1_000), ClaudeAuthError);
});

test('credential encoding round-trips, accepts only the prefix, and defaults a missing lifetime to 8 hours', async () => {
  const value = { accessToken: 'at', refreshToken: 'rt', expiresAt: 123, label: 'me@example.com' };
  assert.deepEqual(decodeClaudeCredential(encodeClaudeCredential(value)), value);
  assert.equal(decodeClaudeCredential('sk-ant-oat01-x'), undefined);
  assert.equal(decodeClaudeCredential(''), undefined);
  assert.equal(decodeClaudeCredential('claude-subscription:%%%'), undefined);
  assert.equal(decodeClaudeCredential(`claude-subscription:${Buffer.from('{"accessToken":""}').toString('base64url')}`), undefined);
  const { attempt } = await beginClaudeSignIn();
  const { fetch } = tokenFetch(() => json(200, { access_token: 'at' }));
  const decoded = decodeClaudeCredential(await completeClaudeSignIn(fetch, attempt, 'c'));
  assert.ok(decoded && Math.abs(decoded.expiresAt - (Date.now() + 8 * 3600 * 1000)) < 5_000);
  assert.equal(claudeNeedsRefresh({ accessToken: 'a', expiresAt: 10_000 }, 10_000 - 5 * 60_000), true);
  assert.equal(claudeNeedsRefresh({ accessToken: 'a', expiresAt: 10_000 }, 10_000 - 5 * 60_000 - 1), false);
});

test('refreshClaudeCredential rotates the grant, keeps the old refresh token when none returns, and maps failures', async () => {
  const current = { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 1, label: 'me@example.com' };
  const rotated = tokenFetch(() => json(200, { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 }));
  const next = decodeClaudeCredential(await refreshClaudeCredential(rotated.fetch, current));
  assert.deepEqual(rotated.calls[0].body, { grant_type: 'refresh_token', refresh_token: 'rt-1', client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e' });
  assert.equal(next?.accessToken, 'at-2');
  assert.equal(next?.refreshToken, 'rt-2');
  assert.equal(next?.label, 'me@example.com');
  const kept = tokenFetch(() => json(200, { access_token: 'at-3' }));
  assert.equal(decodeClaudeCredential(await refreshClaudeCredential(kept.fetch, current))?.refreshToken, 'rt-1');
  for (const status of [400, 401, 403]) {
    const denied = tokenFetch(() => json(status, {}));
    await assert.rejects(() => refreshClaudeCredential(denied.fetch, current), (e: Error) => e instanceof ClaudeReconnectRequiredError && (e as ClaudeReconnectRequiredError).status === 401);
  }
  const down = tokenFetch(() => json(500, { error: 'SECRET' }));
  await assert.rejects(() => refreshClaudeCredential(down.fetch, current), (e: Error) => e instanceof ClaudeAuthError && (e as ClaudeAuthError).status === 502 && !e.message.includes('SECRET'));
  await assert.rejects(() => refreshClaudeCredential(down.fetch, { accessToken: 'at', expiresAt: 1 }), ClaudeReconnectRequiredError);
});

test('claudeTokenRelayFetch posts the same body to the host path and refuses other URLs and unsafe paths', async () => {
  for (const path of ['', 'relative', '//evil.example/x', '/a//b', '/a/../b', '/a?x=1', '/a#x', '/a\\b', '/a b', 'https://evil.example/x']) {
    assert.throws(() => claudeTokenRelayFetch({ path }), TypeError, path);
  }
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(input), init: init ?? {} }); return json(200, { access_token: 'at' }); }) as typeof fetch;
  try {
    const relay = claudeTokenRelayFetch({ path: '/api/ai/claude/token' });
    await relay(CLAUDE_TOKEN_URL, { method: 'POST', body: '{"a":1}', headers: { Authorization: 'leak' } });
    assert.equal(calls[0].url, '/api/ai/claude/token');
    assert.equal(calls[0].init.body, '{"a":1}');
    assert.equal(calls[0].init.credentials, 'same-origin');
    assert.equal(calls[0].init.redirect, 'error');
    assert.equal(calls[0].init.cache, 'no-store');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, undefined);
    await assert.rejects(() => relay('https://evil.example/token', { method: 'POST', body: '{}' }));
    await assert.rejects(() => relay('/api/other', { method: 'POST', body: '{}' }));
    assert.equal(calls.length, 1);
  } finally { globalThis.fetch = original; }
});

test('claude() offers paste-code sign-in only with a subscription binding and not while paused', () => {
  const { fetch } = tokenFetch(() => json(200, {}));
  const v = vault(null);
  const subscription = { tokenFetch: fetch, readCredential: v.read, saveCredential: v.save };
  assert.deepEqual(claude().signIn.map(method => method.kind), ['api-key']);
  assert.deepEqual(claude({ subscriptionsPaused: true, subscription }).signIn.map(method => method.kind), ['api-key']);
  const methods = claude({ subscription }).signIn;
  assert.deepEqual(methods.map(method => method.kind), ['pkce', 'api-key']);
  assert.deepEqual(methods[0], { kind: 'pkce', handshakeViaSite: true, completion: 'paste-code' });
});

test('an encoded credential streams with its access token as Bearer, the OAuth beta and the system prefix', async () => {
  const stored = credential();
  const v = vault(stored);
  const { fetch, calls: tokenCalls } = tokenFetch(() => json(500, {}));
  const provider = claude({ subscription: { tokenFetch: fetch, readCredential: v.read, saveCredential: v.save } });
  await withApi(() => sse('ok'), async calls => {
    assert.equal(await drain(provider.stream(stored, { model: 'm', messages })), 'ok');
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer at-1');
    assert.ok(!JSON.stringify(calls[0]).includes('claude-subscription:'));
    assert.equal(headers['anthropic-beta'], CLAUDE_OAUTH_BETA);
    assert.equal(headers['x-api-key'], undefined);
    const body = JSON.parse(String(calls[0].init.body));
    assert.deepEqual(body.system, [{ type: 'text', text: CLAUDE_CODE_SYSTEM_PREFIX }, { type: 'text', text: 'be brief' }]);
  });
  assert.equal(tokenCalls.length, 0);
});

test('raw sk-ant tokens still pass through unchanged and unrefreshed', async () => {
  const provider = claude();
  await withApi(() => sse('ok'), async calls => {
    await drain(provider.stream('sk-ant-oat01-raw', { model: 'm', messages }));
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer sk-ant-oat01-raw');
    await drain(provider.stream('sk-ant-api03-key', { model: 'm', messages }));
    assert.equal((calls[1].init.headers as Record<string, string>)['x-api-key'], 'sk-ant-api03-key');
  });
});

test('a credential near expiry is refreshed once, saved, and rotation lands in the vault', async () => {
  const stored = credential({ expiresAt: Date.now() + 60_000 });
  const v = vault(stored);
  const { fetch, calls: tokenCalls } = tokenFetch(() => json(200, { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 }));
  const provider = claude({ subscription: { tokenFetch: fetch, readCredential: v.read, saveCredential: v.save } });
  await withApi(() => sse('ok'), async calls => {
    await drain(provider.stream(stored, { model: 'm', messages }));
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer at-2');
  });
  assert.equal(tokenCalls.length, 1);
  assert.equal(decodeClaudeCredential(v.state.value)?.refreshToken, 'rt-2');
});

for (const locks of [false, true]) {
  test(`parallel streams share one refresh ${locks ? 'with' : 'without'} navigator.locks`, async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const held: string[] = [];
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: locks ? { locks: { request: async (name: string, _o: unknown, run: () => Promise<unknown>) => { held.push(name); return run(); } } } : {},
    });
    try {
      const stored = credential({ expiresAt: Date.now() + 1_000 });
      const v = vault(stored);
      const { fetch, calls: tokenCalls } = tokenFetch(async () => { await new Promise(resolve => setTimeout(resolve, 10)); return json(200, { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 }); });
      const provider = claude({ subscription: { tokenFetch: fetch, readCredential: v.read, saveCredential: v.save, namespace: 'site' } });
      await withApi(() => sse('ok'), async () => {
        await Promise.all([1, 2, 3].map(() => drain(provider.stream(stored, { model: 'm', messages }))));
      });
      assert.equal(tokenCalls.length, 1);
      if (locks) assert.deepEqual(held, ['byos-claude-refresh:site']);
    } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original); else delete (globalThis as { navigator?: unknown }).navigator;
    }
  });
}

test('a refresh never overwrites a credential that changed meanwhile', async () => {
  const stored = credential({ expiresAt: Date.now() + 1_000 });
  const newer = credential({ accessToken: 'at-newer', refreshToken: 'rt-newer' });
  const v = vault(stored);
  const { fetch } = tokenFetch(async () => { v.state.value = newer; return json(200, { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 }); });
  const provider = claude({ subscription: { tokenFetch: fetch, readCredential: v.read, saveCredential: v.save } });
  await withApi(() => sse('ok'), async calls => {
    await drain(provider.stream(stored, { model: 'm', messages }));
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer at-newer');
  });
  assert.equal(v.state.value, newer);
});

test('a rejected refresh asks for a reconnect with status 401, and a disconnect during refresh does too', async () => {
  const stored = credential({ expiresAt: Date.now() + 1_000 });
  const v = vault(stored);
  const denied = tokenFetch(() => json(400, { error: 'invalid_grant' }));
  const provider = claude({ subscription: { tokenFetch: denied.fetch, readCredential: v.read, saveCredential: v.save } });
  await assert.rejects(() => drain(provider.stream(stored, { model: 'm', messages })), (e: Error) => e instanceof ClaudeReconnectRequiredError && (e as ClaudeReconnectRequiredError).status === 401);
  await assert.rejects(() => provider.listModels(stored), ClaudeReconnectRequiredError);
  const gone = vault(stored);
  const wipes = tokenFetch(() => { gone.state.value = null; return json(200, { access_token: 'at-2', expires_in: 3600 }); });
  const second = claude({ subscription: { tokenFetch: wipes.fetch, readCredential: gone.read, saveCredential: gone.save } });
  await assert.rejects(() => drain(second.stream(stored, { model: 'm', messages })), ClaudeReconnectRequiredError);
  assert.equal(gone.state.value, null);
});

test('an expired credential without a subscription binding (or refresh token) needs a reconnect; a fresh one just works', async () => {
  const expired = credential({ expiresAt: Date.now() - 1_000 });
  await assert.rejects(() => drain(claude().stream(expired, { model: 'm', messages })), ClaudeReconnectRequiredError);
  const { fetch } = tokenFetch(() => json(500, {}));
  const v = vault(null);
  const noRefresh = encodeClaudeCredential({ accessToken: 'at', expiresAt: Date.now() - 1_000 });
  await assert.rejects(() => drain(claude({ subscription: { tokenFetch: fetch, readCredential: v.read, saveCredential: v.save } }).stream(noRefresh, { model: 'm', messages })), ClaudeReconnectRequiredError);
  await withApi(() => sse('ok'), async () => {
    assert.equal(await drain(claude().stream(credential(), { model: 'm', messages })), 'ok');
  });
  await assert.rejects(() => drain(claude().stream('claude-subscription:garbage', { model: 'm', messages })), ClaudeReconnectRequiredError);
});

test('a 401 from /messages forces one refresh and one retry; a second 401 surfaces', async () => {
  const stored = credential();
  const v = vault(stored);
  const { fetch, calls: tokenCalls } = tokenFetch(() => json(200, { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 }));
  const provider = claude({ subscription: { tokenFetch: fetch, readCredential: v.read, saveCredential: v.save } });
  await withApi((_url, init) => (init.headers as Record<string, string>).Authorization === 'Bearer at-2' ? sse('ok') : json(401, { error: { message: 'bad' } }), async calls => {
    assert.equal(await drain(provider.stream(stored, { model: 'm', messages })), 'ok');
    assert.equal(calls.length, 2);
  });
  assert.equal(tokenCalls.length, 1);
  assert.equal(decodeClaudeCredential(v.state.value)?.accessToken, 'at-2');

  const again = vault(credential());
  const loop = tokenFetch(() => json(200, { access_token: 'at-3', expires_in: 3600 }));
  const stubborn = claude({ subscription: { tokenFetch: loop.fetch, readCredential: again.read, saveCredential: again.save } });
  await withApi(() => json(401, { error: { message: 'still bad' } }), async calls => {
    await assert.rejects(() => drain(stubborn.stream(again.state.value!, { model: 'm', messages })), (e: Error & { status?: number }) => e.status === 401);
    assert.equal(calls.length, 2);
  });
  assert.equal(loop.calls.length, 1);

  // Raw tokens and API keys are never refreshed or retried.
  await withApi(() => json(401, { error: {} }), async calls => {
    await assert.rejects(() => drain(claude().stream('sk-ant-oat01-raw', { model: 'm', messages })));
    assert.equal(calls.length, 1);
  });
});

test('listModels with an encoded credential sends the access token and retries once on 401', async () => {
  const stored = credential();
  const v = vault(stored);
  const { fetch } = tokenFetch(() => json(200, { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 }));
  const provider = claude({ subscription: { tokenFetch: fetch, readCredential: v.read, saveCredential: v.save } });
  await withApi((_url, init) => (init.headers as Record<string, string>).Authorization === 'Bearer at-2' ? json(200, { data: [{ id: 'claude-x', display_name: 'Claude X' }] }) : json(401, {}), async calls => {
    assert.deepEqual(await provider.listModels(stored), [{ id: 'claude-x', name: 'Claude X' }]);
    assert.equal(calls.length, 2);
  });
});

test('a paused host refuses encoded subscription credentials', async () => {
  const { fetch } = tokenFetch(() => json(200, {}));
  const v = vault(null);
  const provider = claude({ subscriptionsPaused: true, subscription: { tokenFetch: fetch, readCredential: v.read, saveCredential: v.save } });
  await assert.rejects(() => provider.listModels(credential()), /paused/);
});
