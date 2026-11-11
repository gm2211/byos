import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
// Built output: the sources use NodeNext `.js` imports.
import {
  chatGPTFriendlyError, ChatGPTResponsesStream, claudeAcceptsTemperature, claudeEmptyResponseMessage,
  claudeThinksByDefault, RequestPacer, shapeChatGPTBody, shapeClaudeBody, type ChatTurn,
} from '../dist/index.js';

const vectors = JSON.parse(readFileSync(new URL('../conformance/request-shaping.json', import.meta.url), 'utf8'));

test('Claude models: which take temperature and which think by default', () => {
  for (const c of vectors.claudeModels as { model: string; acceptsTemperature: boolean; thinksByDefault: boolean }[]) {
    assert.equal(claudeAcceptsTemperature(c.model), c.acceptsTemperature, c.model);
    assert.equal(claudeThinksByDefault(c.model), c.thinksByDefault, c.model);
  }
});

test('Claude bodies follow the shared vectors', () => {
  type Case = { name: string; input: { model: string; maxTokens: number; temperature?: number; effort?: string; subscription: boolean; instructions: string }; expect: { maxTokens: number; temperature: number | null; effort: string | null; thinking: boolean; system: string | string[] } };
  for (const c of vectors.claudeBodies as Case[]) {
    const messages = [{ role: 'user', content: 'hi' }];
    const body = shapeClaudeBody({ ...c.input, messages });
    assert.equal(body.model, c.input.model, c.name);
    assert.deepEqual(body.messages, messages, c.name);
    assert.equal(body.max_tokens, c.expect.maxTokens, c.name);
    assert.equal(body.temperature, c.expect.temperature ?? undefined, c.name);
    assert.equal((body.output_config as { effort?: string } | undefined)?.effort, c.expect.effort ?? undefined, c.name);
    assert.deepEqual(body.thinking, c.expect.thinking ? { type: 'adaptive' } : undefined, c.name);
    const system = Array.isArray(c.expect.system) ? c.expect.system.map(text => ({ type: 'text', text })) : c.expect.system;
    assert.deepEqual(body.system, system, c.name);
  }
});

test('Claude bodies add tools and stream only when asked', () => {
  const plain = shapeClaudeBody({ model: 'claude-sonnet-5-5', messages: [], subscription: false, maxTokens: 10 });
  assert.equal('tools' in plain || 'stream' in plain, false);
  const full = shapeClaudeBody({ model: 'claude-sonnet-5-5', messages: [], subscription: false, maxTokens: 10, stream: true, tools: [{ name: 't' }] });
  assert.equal(full.stream, true);
  assert.deepEqual(full.tools, [{ name: 't' }]);
});

test('Claude empty answers say why', () => {
  for (const c of vectors.claudeEmpty as { stopReason: string | null; expect: string }[]) assert.equal(claudeEmptyResponseMessage(c.stopReason), c.expect);
});

test('ChatGPT bodies follow the shared vectors', () => {
  for (const c of vectors.chatgptBodies as { name: string; model: string; instructions: string; turns: ChatTurn[]; expect: unknown }[]) {
    assert.deepEqual(shapeChatGPTBody(c), c.expect, c.name);
  }
});

test('ChatGPT streams follow the shared vectors', () => {
  for (const c of vectors.chatgptStreams as { name: string; lines: string[]; expect: { text?: string; error?: string } }[]) {
    const read = () => {
      const stream = new ChatGPTResponsesStream(vectors.appName);
      for (const line of c.lines) if (stream.consume(line)) break;
      return stream.finish();
    };
    if (c.expect.error) assert.throws(read, { name: 'ChatGPTResponseError', message: c.expect.error }, c.name);
    else assert.equal(read(), c.expect.text, c.name);
  }
});

test('ChatGPT error codes become plain sentences', () => {
  for (const c of vectors.chatgptErrors as { code: string | null; message: string | null; expect: string }[]) {
    assert.equal(chatGPTFriendlyError(c.code, c.message, vectors.appName), c.expect, String(c.code));
  }
});

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('pacer holds background work while a foreground request runs', async () => {
  const pacer = new RequestPacer();
  await pacer.start('foreground');
  let started = false;
  const background = pacer.start('background').then(() => { started = true; });
  await tick();
  assert.equal(started, false);
  assert.equal(pacer.waitingInBackground, 1);
  pacer.finish('foreground');
  await background;
  assert.equal(started, true);
  assert.equal(pacer.inFlightInBackground, 1);
});

test('pacer runs background work one at a time by default, in order', async () => {
  const pacer = new RequestPacer();
  const order: number[] = [];
  await pacer.start('background');
  const second = pacer.start('background').then(() => order.push(2));
  const third = pacer.start('background').then(() => order.push(3));
  await tick();
  assert.deepEqual(order, []);
  pacer.finish('background');
  await second;
  assert.deepEqual(order, [2]);
  pacer.finish('background');
  await third;
  assert.deepEqual(order, [2, 3]);
});

test('pacer lets wider work run several at once', async () => {
  const pacer = new RequestPacer();
  for (let i = 0; i < 3; i++) await pacer.start('background', 3);
  assert.equal(pacer.inFlightInBackground, 3);
  let fourth = false;
  void pacer.start('background', 3).then(() => { fourth = true; });
  await tick();
  assert.equal(fourth, false);
});

test('foreground never waits, and run releases its slot on failure', async () => {
  const pacer = new RequestPacer();
  await pacer.start('background');
  await assert.rejects(pacer.run('foreground', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(pacer.inFlightInForeground, 0);
  assert.equal(await pacer.run('foreground', async () => 7), 7);
});
