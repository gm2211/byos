// Built output: the sources use NodeNext `.js` imports, so tests run against dist/.
// Synthetic tokens and responses only: nothing here shows OpenAI accepts a live sign-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginChatGptPlanSignIn,
  chatgptPlan,
  ChatGptPlanAuthError,
  ChatGptPlanReconnectRequiredError,
  completeChatGptPlanSignIn,
  createChatGptPlanRegistration,
  decodeChatGptPlanAttempt,
  decodeChatGptPlanCredential,
  decodeCodexCredential,
  encodeChatGptPlanAttempt,
  encodeChatGptPlanCredential,
  parseChatGptPlanModels,
  readChatGptPlanCallback,
} from '../dist/index.js';

type Call = { url: string; init: RequestInit };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sse = (events: unknown[]) => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL, init: RequestInit = {}) => { calls.push({ url: String(input), init }); return handler(String(input), init); };
  return { fetch, calls };
}
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
const completed = { type: 'response.completed', response: { status: 'completed', output: [] } };
const HOST = 'urn:uuid:11111111-2222-4333-8444-555555555555';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
async function collect(iter: AsyncIterable<{ type: string; text?: string }>) {
  let text = '';
  for await (const ev of iter) if (ev.type === 'text') text += ev.text;
  return text;
}
function tokens(attempt: { nonce: string }, clientId: string, over: Record<string, unknown> = {}) {
  return {
    access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: SCOPE,
    id_token: jwt({ iss: 'https://auth.openai.com', aud: clientId, nonce: attempt.nonce, exp: Math.floor(Date.now() / 1000) + 600, email: 'driver@example.invalid' }),
    ...over,
  };
}

test('begin: a first sign-in registers the app; a returning one reuses its client id', async () => {
  const first = await beginChatGptPlanSignIn({ appName: 'My App', hostId: HOST });
  const url = new URL(first.url);
  assert.equal(url.origin + url.pathname, 'https://auth.openai.com/api/accounts/authorize');
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:1455/auth/callback');
  assert.equal(url.searchParams.get('scope'), SCOPE);
  assert.equal(url.searchParams.get('resource'), 'https://api.openai.com/v1');
  assert.equal(url.searchParams.get('ext_agent_host_id'), HOST);
  assert.equal(url.searchParams.get('agent_name_hint'), 'My App');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), first.attempt.state);
  assert.ok(!first.url.includes('+'), 'spaces are %20, never "+"');
  assert.ok(!first.url.includes(first.attempt.verifier));

  const again = await beginChatGptPlanSignIn({ appName: 'My App', hostId: HOST, clientId: 'client-issued' });
  const params = new URL(again.url).searchParams;
  assert.equal(params.get('client_id'), 'client-issued');
  assert.equal(params.get('agent_name_hint'), null);
  assert.deepEqual(decodeChatGptPlanAttempt(encodeChatGptPlanAttempt(again.attempt)), again.attempt);
  assert.equal(decodeChatGptPlanAttempt('chatgpt-plan-attempt:nope'), undefined);
});

test('callback: reads a pasted address, checks state and the client id', () => {
  const attempt = { state: 'state-1' };
  assert.deepEqual(readChatGptPlanCallback(' http://127.0.0.1:1455/auth/callback?code=c1&state=state-1&client_id=issued ', attempt), { code: 'c1', clientId: 'issued' });
  assert.deepEqual(readChatGptPlanCallback('code=c1&state=state-1&client_id=issued', attempt), { code: 'c1', clientId: 'issued' });
  assert.deepEqual(readChatGptPlanCallback('?code=c1&state=state-1', { state: 'state-1', clientId: 'saved' }), { code: 'c1', clientId: 'saved' });
  assert.deepEqual(readChatGptPlanCallback('', attempt), { error: 'missing' });
  assert.deepEqual(readChatGptPlanCallback('123456', attempt), { error: 'missing' });
  assert.deepEqual(readChatGptPlanCallback('http://127.0.0.1:1455/auth/callback?code=c1&state=other&client_id=issued', attempt), { error: 'state-mismatch' });
  assert.deepEqual(readChatGptPlanCallback('?code=c1&state=state-1&client_id=other', { state: 'state-1', clientId: 'saved' }), { error: 'state-mismatch' });
  assert.deepEqual(readChatGptPlanCallback('?error=access_denied&state=state-1', attempt), { error: 'declined' });
  assert.deepEqual(readChatGptPlanCallback('?code=c1&state=state-1', attempt), { error: 'no-client' });
  assert.deepEqual(readChatGptPlanCallback('?code=c1&state=state-1&client_id=dynamic_agent_client', attempt), { error: 'no-client' });
  assert.deepEqual(readChatGptPlanCallback('?code=c1&code=c2&state=state-1&client_id=issued', attempt), { error: 'failed' });
});

test('complete: exchanges the code straight with OpenAI and returns an encoded credential', async () => {
  const { attempt } = await beginChatGptPlanSignIn({ appName: 'My App', hostId: HOST });
  const { fetch, calls } = fakeFetch(() => json(200, tokens(attempt, 'issued')));
  const done = await completeChatGptPlanSignIn(attempt, `http://127.0.0.1:1455/auth/callback?code=c1&state=${attempt.state}&client_id=issued`, { fetch });
  assert.equal(done.clientId, 'issued');
  assert.equal(done.label, 'driver@example.invalid');
  const credential = decodeChatGptPlanCredential(done.credential);
  assert.equal(credential?.accessToken, 'at-1');
  assert.equal(credential?.refreshToken, 'rt-1');
  assert.equal(credential?.clientId, 'issued');
  assert.equal(decodeCodexCredential(done.credential)?.refreshToken, undefined, 'not a Codex device-code credential');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://auth.openai.com/api/accounts/oauth/token');
  const body = new URLSearchParams(String(calls[0].init.body));
  assert.deepEqual(Object.fromEntries(body), {
    grant_type: 'authorization_code', client_id: 'issued', code: 'c1', code_verifier: attempt.verifier,
    redirect_uri: 'http://127.0.0.1:1455/auth/callback', resource: 'https://api.openai.com/v1',
  });
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.redirect, 'error');
});

test('complete: refuses a wrong paste, a wrong nonce, a missing plan grant and a reset registration', async () => {
  const { attempt } = await beginChatGptPlanSignIn({ appName: 'My App', hostId: HOST });
  const pasted = `?code=c1&state=${attempt.state}&client_id=issued`;
  const none = fakeFetch(() => { throw new Error('no request expected'); });
  await assert.rejects(completeChatGptPlanSignIn(attempt, 'hello', { fetch: none.fetch }), (e: ChatGptPlanAuthError) => e.code === 'pasted');
  await assert.rejects(completeChatGptPlanSignIn(attempt, '?code=c1&state=wrong&client_id=issued', { fetch: none.fetch }), (e: ChatGptPlanAuthError) => e.code === 'pasted');
  await assert.rejects(completeChatGptPlanSignIn(attempt, pasted, { fetch: none.fetch, now: attempt.createdAt + 21 * 60_000 }), (e: ChatGptPlanAuthError) => e.code === 'expired');
  assert.equal(none.calls.length, 0);

  const secret = 'provider said something secret';
  const cases: Array<[Response, ChatGptPlanAuthError['code']]> = [
    [json(200, tokens({ nonce: 'someone-elses' }, 'issued')), 'failed'],
    [json(200, tokens(attempt, 'another-client')), 'failed'],
    [json(200, tokens(attempt, 'issued', { scope: 'openid profile email' })), 'plan-not-granted'],
    [json(200, tokens(attempt, 'issued', { id_token: undefined })), 'failed'],
    [json(400, { error: 'invalid_client', error_description: secret }), 'registration-reset'],
    [json(400, { error: 'invalid_grant', error_description: secret }), 'expired'],
    [json(500, { error: secret }), 'failed'],
  ];
  for (const [response, code] of cases) {
    const { fetch } = fakeFetch(() => response);
    await assert.rejects(completeChatGptPlanSignIn(attempt, pasted, { fetch }), (e: ChatGptPlanAuthError) => {
      assert.ok(e instanceof ChatGptPlanAuthError);
      assert.equal(e.code, code);
      assert.ok(!e.message.includes(secret));
      return true;
    });
  }
});

test('registration: the host id is stable and the client id outlives a sign-out', () => {
  const data = new Map<string, string>();
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
  const registration = createChatGptPlanRegistration({ prefix: 'app-chatgpt:', storage });
  const host = registration.hostId();
  assert.match(host, /^urn:uuid:[0-9a-f-]{36}$/);
  assert.equal(createChatGptPlanRegistration({ prefix: 'app-chatgpt:', storage }).hostId(), host);
  assert.equal(registration.clientId(), undefined);
  registration.saveClientId('issued');
  assert.equal(createChatGptPlanRegistration({ prefix: 'app-chatgpt:', storage }).clientId(), 'issued');
  registration.forgetClientId();
  assert.equal(registration.clientId(), undefined);
  assert.ok([...data.keys()].every(key => key.startsWith('app-chatgpt:')));
});

test('models: plan rows keep only listed models; API rows are accepted too', () => {
  assert.deepEqual(parseChatGptPlanModels({ models: [
    { slug: 'gpt-a', display_name: 'GPT A', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high', description: 'Deep' }], default_reasoning_level: 'low' },
    { slug: 'gpt-hidden', visibility: 'hide' },
    { slug: 'gpt-a', visibility: 'list' },
    { slug: 'bad id', visibility: 'list' },
  ] }), [{ id: 'gpt-a', name: 'GPT A', reasoningEfforts: [{ effort: 'low' }, { effort: 'high', description: 'Deep' }], defaultReasoningEffort: 'low' }]);
  assert.deepEqual(parseChatGptPlanModels({ data: [{ id: 'gpt-b' }] }), [{ id: 'gpt-b', name: 'gpt-b' }]);
  assert.deepEqual(parseChatGptPlanModels(null), []);
});

test('stream: goes straight to api.openai.com with a plan-shaped body', async () => {
  const token = encodeChatGptPlanCredential({ accessToken: 'at-1', refreshToken: 'rt-1', clientId: 'issued', expiresAt: Date.now() + 3600_000 });
  const { fetch, calls } = fakeFetch(() => sse([{ type: 'response.output_text.delta', delta: 'Brake ' }, { type: 'response.output_text.delta', delta: 'later.' }, completed]));
  const provider = chatgptPlan({ appName: 'My App', fetch, readCredential: () => token, saveCredential: () => {} });
  assert.equal(provider.id, 'chatgpt');
  assert.deepEqual(provider.signIn, [{ kind: 'pkce', handshakeViaSite: false, completion: 'paste-code' }]);
  assert.notEqual(provider.webSearch, true);
  const text = await collect(provider.stream(token, { model: 'gpt-a', effort: 'high', webSearch: true, messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }, { role: 'user', content: 'more' }] }));
  assert.equal(text, 'Brake later.');
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer at-1');
  assert.equal(headers['ChatGPT-Account-Id'], undefined);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    model: 'gpt-a', instructions: 'rules', store: false, stream: true, reasoning: { effort: 'high' },
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'yo' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'more' }] },
    ],
  });
});

test('stream: an expiring credential is refreshed first and the rotated one is saved', async () => {
  let stored = encodeChatGptPlanCredential({ accessToken: 'old', refreshToken: 'rt-old', clientId: 'issued', expiresAt: Date.now() + 30_000, label: 'driver@example.invalid' });
  const { fetch, calls } = fakeFetch((url, init) => {
    if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
      assert.deepEqual(Object.fromEntries(new URLSearchParams(String(init.body))), { grant_type: 'refresh_token', client_id: 'issued', refresh_token: 'rt-old', resource: 'https://api.openai.com/v1' });
      return json(200, { access_token: 'new', refresh_token: 'rt-new', expires_in: 3600 });
    }
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer new');
    return sse([{ type: 'response.output_text.delta', delta: 'ok' }, completed]);
  });
  const provider = chatgptPlan({ appName: 'My App', fetch, readCredential: () => stored, saveCredential: v => { stored = v; } });
  assert.equal(await collect(provider.stream(stored, { model: 'm', messages: [{ role: 'user', content: 'q' }] })), 'ok');
  assert.equal(calls.length, 2);
  assert.deepEqual(decodeChatGptPlanCredential(stored), { accessToken: 'new', refreshToken: 'rt-new', clientId: 'issued', expiresAt: decodeChatGptPlanCredential(stored)!.expiresAt, label: 'driver@example.invalid' });
});

test('stream: a 401 refreshes once and retries; a dead grant asks to reconnect', async () => {
  let stored = encodeChatGptPlanCredential({ accessToken: 'old', refreshToken: 'rt-old', clientId: 'issued', expiresAt: Date.now() + 3600_000 });
  let responses = 0;
  const { fetch } = fakeFetch((url, init) => {
    if (url.endsWith('/oauth/token')) return json(200, { access_token: 'new', refresh_token: 'rt-new', expires_in: 3600 });
    responses++;
    return (init.headers as Record<string, string>).Authorization === 'Bearer new' ? sse([{ type: 'response.output_text.delta', delta: 'ok' }, completed]) : json(401, {});
  });
  const provider = chatgptPlan({ appName: 'My App', fetch, readCredential: () => stored, saveCredential: v => { stored = v; } });
  assert.equal(await collect(provider.stream(stored, { model: 'm', messages: [{ role: 'user', content: 'q' }] })), 'ok');
  assert.equal(responses, 2);

  let reset = 0;
  const expired = encodeChatGptPlanCredential({ accessToken: 'old', refreshToken: 'rt-old', clientId: 'issued', expiresAt: Date.now() - 1 });
  const dead = fakeFetch(() => json(400, { error: 'invalid_grant' }));
  const p2 = chatgptPlan({ appName: 'My App', fetch: dead.fetch, readCredential: () => expired, saveCredential: () => {}, onRegistrationReset: () => { reset++; } });
  await assert.rejects(p2.listModels(expired), (e: unknown) => e instanceof ChatGptPlanReconnectRequiredError && e.status === 401);
  assert.equal(reset, 0);
  const gone = fakeFetch(() => json(401, { error: 'invalid_client' }));
  const p3 = chatgptPlan({ appName: 'My App', fetch: gone.fetch, readCredential: () => expired, saveCredential: () => {}, onRegistrationReset: () => { reset++; } });
  await assert.rejects(p3.listModels(expired), ChatGptPlanReconnectRequiredError);
  assert.equal(reset, 1);
  await assert.rejects(p3.listModels('codex-subscription:abc'), ChatGptPlanReconnectRequiredError);
});

test('errors: plan limits read plainly and never carry the provider\'s own text', async () => {
  const token = encodeChatGptPlanCredential({ accessToken: 'at-1', clientId: 'issued', expiresAt: Date.now() + 3600_000 });
  const secret = 'echoed prompt text';
  const failing = (status: number, body: unknown) => chatgptPlan({ appName: 'My App', fetch: fakeFetch(() => json(status, body)).fetch, readCredential: () => token, saveCredential: () => {} });
  const run = (provider: ReturnType<typeof chatgptPlan>) => collect(provider.stream(token, { model: 'm', messages: [{ role: 'user', content: 'q' }] }));
  await assert.rejects(run(failing(429, { error: { code: 'subscription_sharing_usage_limit_exceeded', message: secret } })), (e: Error & { status?: number }) => /limit for My App is used up/.test(e.message) && e.status === 429);
  await assert.rejects(run(failing(403, { error: { code: 'subscription_sharing_user_not_eligible', message: secret } })), (e: Error & { status?: number }) => /Plus and Pro/.test(e.message) && e.status === 0);
  await assert.rejects(run(failing(403, { error: { code: 'chatpass_v2_scope_not_authorized', message: secret } })), ChatGptPlanReconnectRequiredError);
  await assert.rejects(run(failing(400, { error: { code: 'other', message: secret } })), (e: Error) => !e.message.includes(secret) && /failed \(400\)/.test(e.message));
  const models = chatgptPlan({ appName: 'My App', fetch: fakeFetch(() => json(200, { models: [{ slug: 'gpt-a', visibility: 'list' }] })).fetch, readCredential: () => token, saveCredential: () => {} });
  assert.deepEqual(await models.listModels(token), [{ id: 'gpt-a', name: 'gpt-a' }]);
});
