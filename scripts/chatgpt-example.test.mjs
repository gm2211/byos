import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatGptError } from '@byos/chatgpt-local';
import { createExampleServer } from '../examples/chatgpt-local/server.mjs';

test('local UI bridge protects mutations and only returns completed safe output', async t => {
  let calls = 0;
  const example = await createExampleServer({
    status: async () => ({ connected: true, planEnabled: true, account: { id: 'one', label: 'Test account' } }),
    accounts: async () => [{ id: 'one', label: 'Test account', connected: true }],
    listModels: async () => [{ id: 'test-model', name: 'Test model' }],
    generate: async () => { calls++; return { text: 'Completed fixture response.' }; },
  });
  t.after(() => example.close());
  const html = await (await fetch(example.origin)).text();
  const csrf = html.match(/'X-Byos-CSRF':'([a-f0-9]+)'/)[1];
  const url = example.origin + '/api/generate';
  const request = { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: example.origin }, body: JSON.stringify({ input: 'Hello', model: 'test-model' }) };
  assert.equal((await fetch(url, request)).status, 403);
  assert.equal((await fetch(url, { ...request, headers: { ...request.headers, Origin: 'https://foreign.invalid', 'X-Byos-CSRF': csrf } })).status, 403);
  assert.equal(calls, 0);
  const response = await fetch(url, { ...request, headers: { ...request.headers, 'X-Byos-CSRF': csrf } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: 'Completed fixture response.' });
  assert.equal(calls, 1);
});

test('bridge does not expose unexpected client error text', async t => {
  const example = await createExampleServer({ status: async () => { throw Error('fake-secret-must-not-leak'); } });
  t.after(() => example.close());
  const response = await fetch(example.origin + '/api/status');
  assert.equal(response.status, 400);
  assert.equal((await response.text()).includes('fake-secret-must-not-leak'), false);
});

test('bridge preserves actionable usage-limit errors without forwarding raw messages', async t => {
  const example = await createExampleServer({ generate: async () => {
    const error = new ChatGptError('quota');
    error.message = 'fake-provider-secret-must-not-leak';
    throw error;
  } });
  t.after(() => example.close());
  const html = await (await fetch(example.origin)).text();
  const csrf = html.match(/'X-Byos-CSRF':'([a-f0-9]+)'/)[1];
  const response = await fetch(example.origin + '/api/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: example.origin, 'X-Byos-CSRF': csrf },
    body: JSON.stringify({ model: 'test-model', input: 'Hello' }),
  });
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { code: 'quota', error: 'ChatGPT usage is limited. Review your usage in ChatGPT settings.' });
});
