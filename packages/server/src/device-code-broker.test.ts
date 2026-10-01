import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceCodeBroker } from '../dist/device-code-broker.js';

const config = {
  deviceCodeUrl: 'https://provider.example/device',
  tokenUrl: 'https://provider.example/token',
  clientId: 'synthetic-client',
  scope: 'profile',
};

test('configured lifetime and pending-attempt bounds must be finite positive integers', () => {
  for (const maxLifetimeMs of [0, -1, Infinity, NaN, 1.5]) {
    assert.throws(() => createDeviceCodeBroker({ ...config, maxLifetimeMs }), /maxLifetimeMs/);
  }
  for (const maxPending of [0, -1, Infinity, NaN, 1.5]) {
    assert.throws(() => createDeviceCodeBroker({ ...config, maxPending }), /maxPending/);
  }
});

test('device-code start returns safe errors instead of provider bodies or network details', async () => {
  const marker = 'synthetic-provider-private-detail';
  const failedResponse = createDeviceCodeBroker({ ...config, fetch: async (_input, init) => {
    assert.equal(init?.redirect, 'error');
    return new Response(marker, { status: 502 });
  } });
  await assert.rejects(failedResponse.start(), error => {
    assert.match(String(error), /HTTP 502/);
    assert.ok(!String(error).includes(marker));
    return true;
  });

  const fetchFailure = createDeviceCodeBroker({ ...config, fetch: async () => { throw new Error(marker); } });
  await assert.rejects(fetchFailure.start(), error => {
    assert.ok(!String(error).includes(marker));
    return true;
  });
});

test('provider intervals and expiration values must be finite and bounded', async () => {
  for (const interval of ['Infinity', 'NaN', '-1', '901']) {
    const broker = createDeviceCodeBroker({
      ...config,
      fetch: async () => Response.json({ device_code: 'synthetic-device-code', user_code: 'ABCD', verification_uri: 'https://provider.example/activate', interval }),
    });
    await assert.rejects(broker.start(), /invalid polling interval/);
  }
  const badExpiry = createDeviceCodeBroker({
    ...config,
    fetch: async () => Response.json({ device_code: 'synthetic-device-code', user_code: 'ABCD', verification_uri: 'https://provider.example/activate', expires_in: 'Infinity' }),
  });
  await assert.rejects(badExpiry.start(), /invalid expiration/);
});

test('verification links require bounded credential-free HTTPS URLs, including the complete URL', async () => {
  const responseWith = (verification_uri: string, verification_uri_complete?: string) => Response.json({
    device_code: 'synthetic-device-code',
    user_code: 'ABCD',
    verification_uri,
    ...(verification_uri_complete === undefined ? {} : { verification_uri_complete }),
  });
  for (const verification_uri of [
    'javascript:alert(1)',
    'http://provider.example/activate',
    'https://user:password@provider.example/activate',
    `https://provider.example/${'a'.repeat(2_048)}`,
  ]) {
    const broker = createDeviceCodeBroker({ ...config, fetch: async () => responseWith(verification_uri) });
    await assert.rejects(broker.start(), /invalid verification link/);
  }
  for (const verification_uri_complete of [
    'javascript:alert(1)',
    'http://account.example/approve',
    'https://user:password@account.example/approve',
    `https://account.example/${'a'.repeat(2_048)}`,
  ]) {
    const broker = createDeviceCodeBroker({
      ...config,
      fetch: async () => responseWith('https://provider.example/activate', verification_uri_complete),
    });
    await assert.rejects(broker.start(), /invalid verification link/);
  }

  const broker = createDeviceCodeBroker({
    ...config,
    fetch: async () => responseWith('https://provider.example/activate#enter-code', 'https://accounts.example/approve?code=ABCD#confirm'),
  });
  const start = await broker.start();
  assert.equal(start.verificationUriComplete, 'https://accounts.example/approve?code=ABCD#confirm');
});

test('unknown provider errors use generic copy and omit provider descriptions', async () => {
  const marker = 'synthetic-provider-private-detail';
  let calls = 0;
  const broker = createDeviceCodeBroker({
    ...config,
    now: () => 100_000,
    fetch: async (_input, init) => {
      assert.equal(init?.redirect, 'error');
      calls++;
      return calls === 1
        ? Response.json({ device_code: 'synthetic-device-code', user_code: 'ABCD', verification_uri: 'https://provider.example/activate' })
        : Response.json({ error: 'provider_internal_error', error_description: marker }, { status: 400 });
    },
  });
  const started = await broker.start();
  const result = await broker.poll(started.attemptId);
  assert.equal(result.pending, false);
  assert.equal(result.error, 'Authorization could not be completed. Try again.');
  assert.ok(!JSON.stringify(result).includes(marker));
});

test('zero provider interval retains the safe three-second polling floor', async () => {
  let calls = 0;
  let time = 100_000;
  const broker = createDeviceCodeBroker({ ...config, now: () => time, fetch: async () => {
    calls++;
    return calls === 1
      ? Response.json({ device_code: 'synthetic-device-code', user_code: 'ABCD', verification_uri: 'https://provider.example/activate', interval: 0 })
      : Response.json({ error: 'authorization_pending' }, { status: 400 });
  } });
  const start = await broker.start();
  assert.equal(start.interval, 3);
  await broker.poll(start.attemptId);
  const before = calls;
  time += 2_999;
  await broker.poll(start.attemptId);
  assert.equal(calls, before);
  time++;
  await broker.poll(start.attemptId);
  assert.equal(calls, before + 1);
});
