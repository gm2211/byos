import assert from 'node:assert/strict';
import test from 'node:test';
import { completedText } from '../dist/http.js';

const message = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }], ...extra,
});
const itemDone = (index: number, item: unknown) => ({ type: 'response.output_item.done', output_index: index, item });
const completed = (extra: Record<string, unknown> = {}) => ({ type: 'response.completed', response: { status: 'completed', output: [], ...extra } });
function response(events: unknown[], chunkSize?: number) {
  const bytes = new TextEncoder().encode(events.map(e => typeof e === 'string' ? e : `data: ${JSON.stringify(e)}\r\n\r\n`).join(''));
  if (!chunkSize) return new Response(bytes);
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset >= bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.slice(offset, offset + chunkSize)); offset += chunkSize;
  } }));
}

for (const [name, terminal] of [
  ['empty array', completed()], ['null output', completed({ output: null })], ['omitted output', { type: 'response.completed', response: { status: 'completed' } }],
] as const) {
  test(`completed items supply text for sparse terminal ${name}`, async () => {
    assert.equal(await completedText(response([
      { type: 'response.created', response: { status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: message('', { status: 'in_progress' }) },
      { type: 'response.output_text.delta', output_index: 0, delta: 'Draft' },
      { type: 'response.output_text.done', output_index: 0, text: 'Draft' },
      { type: 'response.content_part.done', output_index: 0, part: { type: 'output_text', text: 'Draft' } },
      itemDone(0, message('Draft')), terminal,
    ], 7), []), 'Draft');
  });
}

test('populated terminal snapshot stays authoritative without duplicate item text', async () => {
  assert.equal(await completedText(response([itemDone(0, message('Buffered draft')), completed({ output: [message('Final draft')] })]), []), 'Final draft');
});

test('completed output items follow output_index, not arrival order', async () => {
  assert.equal(await completedText(response([itemDone(2, message('Third')), itemDone(0, message('First')), itemDone(1, { type: 'reasoning', summary: [] }), completed()]), []), 'First\nThird');
});

test('commentary phase from added item remains excluded when done omits phase', async () => {
  assert.equal(await completedText(response([
    { type: 'response.output_item.added', output_index: 0, item: message('', { status: 'in_progress', phase: 'commentary' }) },
    itemDone(0, message('Working through the draft')), itemDone(1, message('Final', { phase: 'final_answer' })), completed(),
  ]), []), 'Final');
});

for (const [name, tail] of [
  ['EOF', []], ['DONE alone', ['data: [DONE]\n\n']],
  ['late failure', [{ type: 'response.failed', response: { status: 'failed' } }]],
  ['late incomplete', [{ type: 'response.incomplete', response: { status: 'incomplete' } }]],
  ['false terminal status', [completed({ status: 'incomplete' })]],
  ['terminal incomplete details', [completed({ incomplete_details: { reason: 'max_output_tokens' } })]],
  ['malformed terminal output', [completed({ output: {} })]],
] as const) {
  test(`completed item is not success before valid terminal completion: ${name}`, async () => {
    await assert.rejects(completedText(response([itemDone(0, message('Partial draft')), ...tail]), []), { code: 'invalid-response' });
  });
}

test('deltas and text.done are not accepted without completed output items', async () => {
  await assert.rejects(completedText(response([{ type: 'response.output_text.delta', delta: 'Partial' }, { type: 'response.output_text.done', text: 'Partial' }, completed()]), []), { code: 'invalid-response' });
});

test('late quota failure remains actionable and does not accept completed item', async () => {
  await assert.rejects(completedText(response([itemDone(0, message('Partial')), { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }]), []), { code: 'quota' });
});

for (const type of ['function_call', 'custom_tool_call', 'mcp_call', 'web_search_call']) {
  test(`buffered unsupported ${type} cannot be hidden by terminal snapshot`, async () => {
    await assert.rejects(completedText(response([itemDone(0, { type }), completed({ output: [message('Draft')] })]), []), { code: 'unsupported' });
  });
}

test('buffered refusal is fatal even when terminal snapshot contains usable text', async () => {
  await assert.rejects(completedText(response([itemDone(0, message('', { content: [{ type: 'refusal', refusal: 'Cannot answer' }] })), completed({ output: [message('Draft')] })]), []), { code: 'invalid-response' });
});

test('buffered text never exposes synthetic credential, including escaped JSON', async () => {
  const secret = 'synthetic-secret';
  const raw = `data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"synthetic-\\u0073ecret"}]}}\n\n`;
  await assert.rejects(completedText(response([raw, completed()]), [secret]), { code: 'invalid-response' });
});

for (const index of [-1, 0.5, 10_000, '0', null]) {
  test(`invalid output_index rejected: ${String(index)}`, async () => {
    await assert.rejects(completedText(response([{ ...itemDone(0, message('Draft')), output_index: index }, completed()]), []), { code: 'invalid-response' });
  });
}

test('duplicate completed index cannot replace previously completed text', async () => {
  await assert.rejects(completedText(response([itemDone(0, message('One')), itemDone(0, message('Two')), completed()]), []), { code: 'invalid-response' });
});

test('event and buffered completed text remain bounded', async () => {
  await assert.rejects(completedText(response([itemDone(0, message('x'.repeat(2 * 1024 * 1024))), completed()]), []), { code: 'invalid-response' });
  await assert.rejects(completedText(response([0, 1, 2, 3, 4].map(i => itemDone(i, message('x'.repeat(1024 * 1024)))).concat([completed() as never])), []), { code: 'invalid-response' });
});

test('abort after completed item prevents text return and closes stream', async () => {
  const controller = new AbortController(); let canceled = false, pulls = 0;
  const stream = new ReadableStream({ pull(s) {
    if (pulls++ === 0) s.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(itemDone(0, message('Draft')))}\n\n`));
    else { controller.abort(); s.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(completed())}\n\n`)); }
  }, cancel() { canceled = true; } });
  await assert.rejects(completedText(new Response(stream), [], controller.signal), { code: 'canceled' });
  assert.equal(canceled, true);
});
