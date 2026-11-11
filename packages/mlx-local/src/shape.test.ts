import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatEvent } from '@byos/core';
import { StreamShaper } from '../dist/shape.js';

function run(chunks: string[], stops = ['<|im_end|>', '<|endoftext|>']): ChatEvent[] {
  const shaper = new StreamShaper(stops);
  return [...chunks.flatMap(chunk => shaper.push(chunk)), ...shaper.end()];
}

const joined = (events: ChatEvent[], type: 'text' | 'reasoning') =>
  events.filter(event => event.type === type).map(event => (event as { text: string }).text).join('');

test('plain text streams through, trimmed', () => {
  const events = run(['  Hello', ' world', '  \n']);
  assert.equal(joined(events, 'text'), 'Hello world');
  assert.equal(joined(events, 'reasoning'), '');
});

test('a leading think block becomes reasoning, even when its tags are split across chunks', () => {
  const events = run(['<th', 'ink>step one', ' step two</th', 'ink>\n\nAnswer']);
  assert.equal(joined(events, 'reasoning'), 'step one step two');
  assert.equal(joined(events, 'text'), 'Answer');
});

test('Gemma 4 channel blocks are reasoning too', () => {
  const events = run(['<|channel>thought', '<channel|>Hi']);
  assert.equal(joined(events, 'reasoning'), 'thought');
  assert.equal(joined(events, 'text'), 'Hi');
});

test('a stop string split across chunks ends the answer and drops the rest', () => {
  const events = run(['Done.', '<|im', '_end|>', 'garbage', 'more']);
  assert.equal(joined(events, 'text'), 'Done.');
});

test('text that only looks like a stop prefix is released at the end', () => {
  assert.equal(joined(run(['a <|im']), 'text'), 'a <|im');
  assert.equal(joined(run(['use <think> tags']), 'text'), 'use <think> tags');
});

test('nothing is emitted that must be taken back', () => {
  const shaper = new StreamShaper(['<|im_end|>']);
  assert.deepEqual(shaper.push('<'), []);
  assert.deepEqual(shaper.push('|im'), []);
  assert.deepEqual(shaper.push('_end|>'), []);
  assert.deepEqual(shaper.end(), []);
});

test('an unterminated think block is all reasoning', () => {
  const events = run(['<think>still going']);
  assert.equal(joined(events, 'reasoning'), 'still going');
  assert.equal(joined(events, 'text'), '');
});
