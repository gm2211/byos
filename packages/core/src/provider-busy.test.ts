import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
// Built output: the sources use NodeNext `.js` imports.
import {
  BUSY_POLICY, BusyCooldowns, ProviderBusyError, decideBusy, isLostConnection, providerErrorMessage,
  retryingLostConnection, sendRetryingWhenBusy, type BusyProvider,
} from '../dist/index.js';

const vectors = JSON.parse(readFileSync(new URL('../conformance/provider-busy.json', import.meta.url), 'utf8'));
const providers = vectors.providers as Record<string, BusyProvider>;
const formatReset = () => '{reset}';

test('the busy policy matches the vectors', () => {
  assert.deepEqual({ ...BUSY_POLICY }, vectors.policy);
});

for (const vector of vectors.decide) {
  test(`decideBusy: ${vector.name}`, () => {
    const decision = decideBusy({ ...vector, provider: providers[vector.provider], now: vectors.now, formatReset });
    assert.deepEqual(decision, vector.expect);
  });
}

test('providerErrorMessage matches every vector and never returns the raw body', () => {
  for (const vector of vectors.messages) {
    const message = providerErrorMessage(providers[vector.provider]!, vector.status, vector.body, vector.headers, { now: vectors.now, formatReset });
    assert.equal(message, vector.expect, JSON.stringify(vector));
    if (vector.body.length > 2) assert.ok(!message.includes(vector.body), message);
  }
  const long = vectors.longDetail;
  const detail = long.repeat.repeat(long.count);
  const message = providerErrorMessage(providers[long.provider]!, long.status, JSON.stringify({ error: { message: detail } }));
  assert.ok(message.startsWith(long.expectPrefix));
  assert.ok(message.endsWith(long.expectSuffix));
  assert.equal([...message.slice(long.expectPrefix.length, -long.expectSuffix.length)].length, long.expectDetailLength);
});

test('cooldowns end, and a shorter one never cuts a longer one short', () => {
  const cooldowns = new BusyCooldowns();
  cooldowns.record('claude', 120, 'long', 1000);
  cooldowns.record('claude', 10, 'short', 1000);
  assert.deepEqual(cooldowns.get('claude', 1000), { remainingSeconds: 120, message: 'long' });
  assert.equal(cooldowns.get('claude', 1121), undefined);
});

const claude = providers['claude-subscription']!;
const rateLimit = JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: "This request would exceed your account's rate limit. Please try again later." } });

function server(replies: Array<[number, string, Record<string, string>?]>) {
  let calls = 0;
  const send = async () => {
    const [status, body, headers] = replies[Math.min(calls, replies.length - 1)]!;
    calls++;
    return new Response(body, { status, headers });
  };
  return { send, calls: () => calls };
}

test('a rate limit is asked again before it becomes an error', async () => {
  const waits: number[] = [];
  const stub = server([[429, rateLimit], [200, '{}']]);
  const response = await sendRetryingWhenBusy(stub.send, { provider: claude, cooldowns: new BusyCooldowns(), wait: async s => { waits.push(s); } });
  assert.equal(response.status, 200);
  assert.equal(stub.calls(), 2);
  assert.deepEqual(waits, [2]);
});

test('a lasting rate limit becomes a plain message and a cooldown that stops the next request', async () => {
  const cooldowns = new BusyCooldowns();
  const stub = server([[429, rateLimit]]);
  const options = { provider: claude, cooldowns, wait: async () => {} };
  await assert.rejects(sendRetryingWhenBusy(stub.send, options), (error: unknown) =>
    error instanceof ProviderBusyError && error.message === "Claude has hit your account's rate limit for the moment. Try again in a minute.");
  assert.equal(stub.calls(), 3);
  await assert.rejects(sendRetryingWhenBusy(stub.send, options), ProviderBusyError);
  assert.equal(stub.calls(), 3, 'the cooldown stops before the network');
});

test('background requests are never retried and stop during any cooldown', async () => {
  const cooldowns = new BusyCooldowns();
  const stub = server([[529, '{}'], [200, '{}']]);
  await assert.rejects(sendRetryingWhenBusy(stub.send, { provider: claude, cooldowns, lane: 'background', wait: async () => {} }), ProviderBusyError);
  assert.equal(stub.calls(), 1);
  cooldowns.record('Claude', 5, 'cooling');
  await assert.rejects(sendRetryingWhenBusy(stub.send, { provider: claude, cooldowns, lane: 'background', wait: async () => {} }), /cooling/);
  assert.equal(stub.calls(), 1);
});

test('a refusal and other failures come back as the response, with no cooldown', async () => {
  const cooldowns = new BusyCooldowns();
  const bare = JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Error' } });
  const stub = server([[429, bare]]);
  const response = await sendRetryingWhenBusy(stub.send, { provider: claude, cooldowns, wait: async () => {} });
  assert.equal(response.status, 429);
  assert.equal(await response.text(), bare, 'the body is still readable');
  assert.equal(stub.calls(), 1);
  assert.equal(cooldowns.get('Claude'), undefined);
});

test('a dropped connection is asked again on a fresh one; other errors are not', async () => {
  const reset = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  assert.ok(isLostConnection(reset));
  assert.ok(!isLostConnection(new TypeError('fetch failed')));
  let calls = 0;
  const value = await retryingLostConnection(async () => { if (calls++ === 0) throw reset; return 'ok'; }, { delaysSeconds: [0] });
  assert.equal(value, 'ok');
  calls = 0;
  await assert.rejects(retryingLostConnection(async () => { calls++; throw new Error('boom'); }, { delaysSeconds: [0] }), /boom/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(retryingLostConnection(async () => { calls++; throw reset; }, { delaysSeconds: [0, 0] }), TypeError);
  assert.equal(calls, 3);
});
