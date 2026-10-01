// Built output: the sources use NodeNext `.js` imports, so tests run against dist/.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  codex,
  decodeCodexCredential,
  encodeCodexCredential,
  parseCodexModelCatalog,
  pollCodexDeviceSignIn,
  startCodexDeviceSignIn,
} from '../dist/index.js';

type Call = { url: string; init: RequestInit };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sse = (events: unknown[]) => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL, init: RequestInit = {}) => { calls.push({ url: String(input), init }); return handler(String(input), init); };
  return { fetch, calls };
}
const completed = { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 5, output_tokens: 2 } } };
async function collect(iter: AsyncIterable<{ type: string; text?: string }>) {
  let text = '';
  for await (const ev of iter) if (ev.type === 'text') text += ev.text;
  return text;
}

test('device sign-in: code, pending, then an encoded credential', async () => {
  let approved = false;
  const { fetch, calls } = fakeFetch((url, init) => {
    if (url.endsWith('/usercode')) return json(200, { device_auth_id: 'dev-1', user_code: 'ABCD-1234', interval: 5, expires_in: 600 });
    if (url.endsWith('/deviceauth/token')) return approved ? json(200, { authorization_code: 'code-1', code_verifier: 'ver-1' }) : json(403, {});
    if (url.endsWith('/oauth/token')) {
      assert.match(String(init.body), /grant_type=authorization_code/);
      return json(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, account_id: 'acct-1' });
    }
    throw new Error(`unexpected ${url}`);
  });
  const start = await startCodexDeviceSignIn(fetch);
  assert.equal(start.userCode, 'ABCD-1234');
  assert.equal(start.verificationUri, 'https://auth.openai.com/codex/device');
  assert.deepEqual(await pollCodexDeviceSignIn(fetch, start), { pending: true });
  approved = true;
  const done = await pollCodexDeviceSignIn(fetch, start);
  assert.equal(done.pending, false);
  const credential = decodeCodexCredential(done.pending ? '' : done.credential);
  assert.equal(credential?.accessToken, 'at-1');
  assert.equal(credential?.refreshToken, 'rt-1');
  assert.equal(credential?.accountId, 'acct-1');
  assert.ok(calls.every(c => c.init.redirect === 'error' && c.init.credentials === 'omit'));
});

test('stream: answer deltas stream, commentary is skipped, account header is sent', async () => {
  const token = encodeCodexCredential({ accessToken: 'at-1', refreshToken: 'rt-1', accountId: 'acct-1', expiresAt: Date.now() + 3600_000 });
  const { fetch, calls } = fakeFetch(() => sse([
    { type: 'response.output_item.added', item: { type: 'message', id: 'c1', phase: 'commentary' } },
    { type: 'response.output_text.delta', item_id: 'c1', delta: 'thinking...' },
    { type: 'response.output_item.added', item: { type: 'message', id: 'f1', phase: 'final_answer' } },
    { type: 'response.output_text.delta', item_id: 'f1', delta: 'Brake ' },
    { type: 'response.output_text.delta', item_id: 'f1', delta: 'later.' },
    completed,
  ]));
  const provider = codex({ fetch, readCredential: () => token, saveCredential: () => {} });
  const text = await collect(provider.stream(token, { model: 'gpt-5.6-luna', messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'hi' }] }));
  assert.equal(text, 'Brake later.');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers['ChatGPT-Account-Id'], 'acct-1');
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.instructions, 'rules');
  assert.equal(body.store, false);
  assert.deepEqual(body.tools, []);
});

test('stream: with no deltas, the final-answer item text is sent once', async () => {
  const token = encodeCodexCredential({ accessToken: 'at-1', expiresAt: Date.now() + 3600_000 });
  const { fetch } = fakeFetch(() => sse([
    { type: 'response.output_item.done', item: { type: 'message', phase: 'commentary', content: [{ type: 'output_text', text: 'aside' }] } },
    { type: 'response.output_item.done', item: { type: 'message', phase: 'final_answer', content: [{ type: 'output_text', text: 'The answer.' }] } },
    completed,
  ]));
  const provider = codex({ fetch, readCredential: () => token, saveCredential: () => {} });
  assert.equal(await collect(provider.stream(token, { model: 'm', messages: [{ role: 'user', content: 'q' }] })), 'The answer.');
});

test('stream: a 401 refreshes once, saves the rotated credential and retries', async () => {
  let stored = encodeCodexCredential({ accessToken: 'old', refreshToken: 'rt-old', expiresAt: Date.now() + 3600_000 });
  let responses = 0;
  const { fetch } = fakeFetch((url, init) => {
    if (url.endsWith('/oauth/token')) {
      assert.match(String(init.body), /refresh_token=rt-old/);
      return json(200, { access_token: 'new', refresh_token: 'rt-new', expires_in: 3600 });
    }
    responses++;
    const auth = (init.headers as Record<string, string>).Authorization;
    return auth === 'Bearer new' ? sse([{ type: 'response.output_text.delta', delta: 'ok' }, completed]) : json(401, {});
  });
  const provider = codex({ fetch, readCredential: () => stored, saveCredential: v => { stored = v; } });
  assert.equal(await collect(provider.stream(stored, { model: 'm', messages: [{ role: 'user', content: 'q' }] })), 'ok');
  assert.equal(responses, 2);
  assert.equal(decodeCodexCredential(stored)?.refreshToken, 'rt-new');
});

test('one canceled inference stops waiting without aborting a shared credential refresh', async () => {
  let stored = encodeCodexCredential({ accessToken: 'old', refreshToken: 'rt-old', expiresAt: Date.now() - 1 });
  let finishRefresh!: (response: Response) => void;
  let markStarted!: () => void;
  const refreshStarted = new Promise<void>(resolve => { markStarted = resolve; });
  const refreshResponse = new Promise<Response>(resolve => { finishRefresh = resolve; });
  const { fetch } = fakeFetch(async (url, init) => {
    if (url.endsWith('/oauth/token')) {
      assert.notEqual(init.signal, controller.signal);
      markStarted();
      return await refreshResponse;
    }
    return sse([{ type: 'response.output_text.delta', delta: 'ok' }, completed]);
  });
  const provider = codex({ fetch, readCredential: () => stored, saveCredential: value => { stored = value; }, namespace: 'garden' });
  const controller = new AbortController();
  const request = { model: 'm', messages: [{ role: 'user' as const, content: 'q' }] };
  const canceled = provider.stream(stored, { ...request, signal: controller.signal })[Symbol.asyncIterator]();
  const canceledNext = canceled.next();
  await refreshStarted;
  const continuing = provider.stream(stored, request)[Symbol.asyncIterator]();
  const continuingNext = continuing.next();
  controller.abort();
  await assert.rejects(canceledNext, { name: 'AbortError' });
  finishRefresh(json(200, { access_token: 'new', refresh_token: 'rt-new', expires_in: 3600 }));
  const first = await continuingNext;
  assert.deepEqual(first.value, { type: 'text', text: 'ok' });
  assert.equal(decodeCodexCredential(stored)?.refreshToken, 'rt-new');
});

test('refresh never overwrites a credential changed while request is in flight', async () => {
  const previous = encodeCodexCredential({ accessToken: 'old', refreshToken: 'rt-old', expiresAt: Date.now() - 1 });
  const replacement = encodeCodexCredential({ accessToken: 'replacement', refreshToken: 'rt-replacement', expiresAt: Date.now() + 3600_000 });
  let stored = previous;
  let finishRefresh!: (response: Response) => void;
  let markStarted!: () => void;
  let saves = 0;
  let inferenceAuth = '';
  const refreshStarted = new Promise<void>(resolve => { markStarted = resolve; });
  const refreshResponse = new Promise<Response>(resolve => { finishRefresh = resolve; });
  const { fetch } = fakeFetch(async (url, init) => {
    if (url.endsWith('/oauth/token')) { markStarted(); return await refreshResponse; }
    inferenceAuth = (init.headers as Record<string, string>).Authorization;
    return sse([{ type: 'response.output_text.delta', delta: 'ok' }, completed]);
  });
  const provider = codex({ fetch, readCredential: () => stored, saveCredential: value => { saves++; stored = value; } });
  const iterator = provider.stream(previous, { model: 'm', messages: [{ role: 'user', content: 'q' }] })[Symbol.asyncIterator]();
  const pending = iterator.next();
  await refreshStarted;
  stored = replacement;
  finishRefresh(json(200, { access_token: 'old-refreshed', refresh_token: 'rt-old-rotated', expires_in: 3600 }));
  assert.deepEqual(await pending, { done: false, value: { type: 'text', text: 'ok' } });
  assert.equal(inferenceAuth, 'Bearer replacement');
  assert.equal(stored, replacement);
  assert.equal(saves, 0);
});

test('disconnect during refresh prevents stale token save and inference', async () => {
  const previous = encodeCodexCredential({ accessToken: 'old', refreshToken: 'rt-old', expiresAt: Date.now() - 1 });
  let stored = previous;
  let finishRefresh!: (response: Response) => void;
  let markStarted!: () => void;
  let saves = 0;
  let inferenceCalls = 0;
  const refreshStarted = new Promise<void>(resolve => { markStarted = resolve; });
  const refreshResponse = new Promise<Response>(resolve => { finishRefresh = resolve; });
  const { fetch } = fakeFetch(async (url) => {
    if (url.endsWith('/oauth/token')) { markStarted(); return await refreshResponse; }
    inferenceCalls++;
    return sse([{ type: 'response.output_text.delta', delta: 'should not run' }, completed]);
  });
  const provider = codex({ fetch, readCredential: () => stored, saveCredential: value => { saves++; stored = value; } });
  const iterator = provider.stream(previous, { model: 'm', messages: [{ role: 'user', content: 'q' }] })[Symbol.asyncIterator]();
  const pending = iterator.next();
  await refreshStarted;
  stored = '';
  finishRefresh(json(200, { access_token: 'old-refreshed', refresh_token: 'rt-old-rotated', expires_in: 3600 }));
  await assert.rejects(pending, /Connect it again/);
  assert.equal(stored, '');
  assert.equal(saves, 0);
  assert.equal(inferenceCalls, 0);
});

test('stream: an echoed credential is refused', async () => {
  const token = encodeCodexCredential({ accessToken: 'secret-at', expiresAt: Date.now() + 3600_000 });
  const { fetch } = fakeFetch(() => sse([{ type: 'response.output_text.delta', delta: 'your token is secret-at' }, completed]));
  const provider = codex({ fetch, readCredential: () => token, saveCredential: () => {} });
  await assert.rejects(collect(provider.stream(token, { model: 'm', messages: [{ role: 'user', content: 'q' }] })), /invalid response/);
});

test('model catalog keeps API-supported rows and marks hidden ones', () => {
  const models = parseCodexModelCatalog({ models: [
    { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6 Luna', supported_in_api: true, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }], default_reasoning_level: 'low' },
    { slug: 'internal', supported_in_api: false },
    { slug: 'old', supported_in_api: true, visibility: 'hide' },
  ] });
  assert.deepEqual(models.map(m => [m.id, !!m.hidden]), [['gpt-5.6-luna', false], ['old', true]]);
  assert.equal(models[0].defaultReasoningEffort, 'low');
});
