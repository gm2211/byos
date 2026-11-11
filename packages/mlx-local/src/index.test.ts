import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ChatEvent } from '@byos/core';
import { onDeviceProvidersFor } from '@byos/providers';
import { createMlxLocal, MlxLocalError, RECOMMENDED_MLX_MODELS } from '../dist/index.js';

const fake = fileURLToPath(new URL('../test-fixtures/fake-byos-mlx.mjs', import.meta.url));

function setup(extra: Parameters<typeof createMlxLocal>[0] = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'byos-mlx-test-'));
  const log = path.join(dir, 'requests.jsonl');
  process.env.FAKE_MLX_LOG = log;
  const local = createMlxLocal({ binaryPath: fake, modelsDir: path.join(dir, 'models'), platformSupported: true, ...extra });
  const requests = () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { local, requests };
}

async function collect(stream: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test('off Apple silicon nothing is offered and nothing is spawned', async () => {
  const local = createMlxLocal({ binaryPath: fake, platformSupported: false });
  assert.deepEqual(onDeviceProvidersFor(local.runtime), []);
  assert.equal(local.mlx.availability().available, false);
  assert.deepEqual(await local.status(), {
    mlx: { available: false, reason: 'On-device MLX needs an Apple silicon Mac.' },
    foundationModels: { available: false, reason: 'On-device MLX needs an Apple silicon Mac.' },
  });
});

test('a missing helper binary is reported, not thrown at construction', () => {
  const local = createMlxLocal({ binaryPath: '/nonexistent/byos-mlx', platformSupported: true });
  const state = local.mlx.availability();
  assert.equal(state.available, false);
  assert.match((state as { reason: string }).reason, /build-bridge/);
});

test('status refreshes per-provider availability', async () => {
  const { local } = setup();
  try {
    assert.deepEqual(onDeviceProvidersFor(local.runtime).map(provider => provider.id), ['mlx', 'foundation-models']);
    const status = await local.status();
    assert.deepEqual(status.mlx, { available: true });
    assert.deepEqual(local.foundationModels.availability(), { available: false, reason: 'Apple Intelligence is off.' });
  } finally { local.close(); }
});

test('streams shaped text, reasoning and usage through the on-device provider', async () => {
  const { local, requests } = setup({ maxTokens: 64 });
  try {
    const provider = local.provider('mlx');
    const events = await collect(provider.stream({
      model: 'mlx-community/Qwen3.5-4B-4bit',
      messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'world' }],
    }));
    const text = events.filter(event => event.type === 'text').map(event => (event as { text: string }).text).join('');
    const reasoning = events.filter(event => event.type === 'reasoning').map(event => (event as { text: string }).text).join('');
    assert.equal(text, 'Hello world');
    assert.equal(reasoning, 'planning');
    assert.deepEqual(events.at(-2), { type: 'usage', inputTokens: 12, outputTokens: 7 });
    assert.deepEqual(events.at(-1), { type: 'done' });
    const sent = requests().find(request => request.op === 'generate');
    assert.equal(sent.engine, 'mlx');
    assert.equal(sent.maxTokens, 64);
    assert.deepEqual(sent.args, ['--models-dir', sent.args[1]]);
    assert.deepEqual(sent.messages, [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'world' }]);
  } finally { local.close(); }
});

test('lists only well-formed downloaded models, with display names', async () => {
  const { local } = setup();
  try {
    assert.deepEqual(await local.mlx.listModels(), [{ id: 'mlx-community/Qwen3.5-4B-4bit', name: 'Qwen3.5 4B', recommended: true }]);
    assert.deepEqual(await local.foundationModels.listModels(), [{ id: 'apple-foundation-model', name: 'Apple Intelligence' }]);
    assert.ok(RECOMMENDED_MLX_MODELS.some(model => model.recommended));
  } finally { local.close(); }
});

test('download reports clamped progress; bad ids never reach the helper', async () => {
  const { local, requests } = setup();
  try {
    const progress: number[] = [];
    await local.download('mlx-community/Qwen3.5-2B-4bit', { onProgress: fraction => progress.push(fraction) });
    assert.deepEqual(progress, [0.5, 1]);
    await assert.rejects(local.download('../../etc'), (error: MlxLocalError) => error.code === 'invalid-model');
    await local.delete('mlx-community/Qwen3.5-2B-4bit');
    assert.deepEqual(requests().map(request => request.op), ['download', 'delete']);
  } finally { local.close(); }
});

test('helper errors keep their code', async () => {
  const { local } = setup();
  try {
    await assert.rejects(collect(local.mlx.stream({ model: 'x/missing', messages: [{ role: 'user', content: 'hi' }] })),
      (error: MlxLocalError) => error.code === 'model-not-downloaded');
  } finally { local.close(); }
});

test('aborting a generation cancels it in the helper', async () => {
  const { local, requests } = setup();
  try {
    const controller = new AbortController();
    const events: ChatEvent[] = [];
    await assert.rejects((async () => {
      for await (const event of local.mlx.stream({ model: 'x/slow', messages: [{ role: 'user', content: 'go' }], signal: controller.signal })) {
        events.push(event);
        if (events.length === 3) controller.abort();
      }
    })(), (error: Error) => error.name === 'AbortError');
    assert.equal(events.length, 3);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(requests().some(request => request.op === 'cancel' && request.target === requests()[0].id));
  } finally { local.close(); }
});

test('a consumer that stops reading early cancels the generation', async () => {
  const { local, requests } = setup();
  try {
    for await (const event of local.mlx.stream({ model: 'x/slow', messages: [{ role: 'user', content: 'go' }] })) {
      assert.equal(event.type, 'text');
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(requests().some(request => request.op === 'cancel'));
  } finally { local.close(); }
});

test('a crashed helper fails the request and restarts on the next call', async () => {
  const { local } = setup();
  try {
    await assert.rejects(collect(local.mlx.stream({ model: 'x/crash', messages: [{ role: 'user', content: 'hi' }] })),
      (error: MlxLocalError) => error.code === 'unavailable');
    assert.deepEqual((await local.status()).mlx, { available: true });
  } finally { local.close(); }
});
