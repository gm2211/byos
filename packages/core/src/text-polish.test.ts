import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
// Built output: the sources use NodeNext `.js` imports.
import { friendlyModelName, trimDegenerateRepetition } from '../dist/index.js';

const vectors = JSON.parse(readFileSync(new URL('../conformance/text-polish.json', import.meta.url), 'utf8'));

test('model ids read as the names people say', () => {
  for (const c of vectors.modelNames as { id: string; expect: string }[]) assert.equal(friendlyModelName(c.id), c.expect, c.id);
});

test('degenerate repetition is trimmed per the shared vectors', () => {
  for (const c of vectors.repetition as { name: string; input: string; expect: { text: string; wasDegenerate: boolean } }[]) {
    assert.deepEqual(trimDegenerateRepetition(c.input), c.expect, c.name);
  }
});

test('a trimmed answer is never empty when the input was not', () => {
  for (const c of vectors.repetition as { input: string }[]) if (c.input) assert.notEqual(trimDegenerateRepetition(c.input).text, '');
});
