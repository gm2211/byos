#!/usr/bin/env node
// A stand-in for the Swift byos-mlx helper that speaks the same protocol, for tests.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = process.env.FAKE_MLX_LOG;
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const timers = new Map();

createInterface({ input: process.stdin }).on('line', raw => {
  const request = JSON.parse(raw);
  if (log) appendFileSync(log, `${JSON.stringify({ ...request, args: process.argv.slice(2) })}\n`);
  const { id } = request;
  switch (request.op) {
    case 'status':
      return send({ id, type: 'result', value: { mlx: { available: true }, foundationModels: { available: false, reason: 'Apple Intelligence is off.' } } });
    case 'list':
      return send({ id, type: 'result', value: { models: [{ id: 'mlx-community/Qwen3.5-4B-4bit', bytes: 2500 }, { id: '../evil', bytes: 1 }] } });
    case 'download':
      send({ id, type: 'progress', fraction: 0.5 });
      send({ id, type: 'progress', fraction: 1.5 });
      return send({ id, type: 'result', value: {} });
    case 'delete':
      return send({ id, type: 'result', value: {} });
    case 'cancel': {
      clearInterval(timers.get(request.target));
      return send({ id: request.target, type: 'error', code: 'aborted', message: 'Canceled.' });
    }
    case 'generate': {
      if (request.model === 'x/missing') return send({ id, type: 'error', code: 'model-not-downloaded', message: 'x/missing is not downloaded.' });
      if (request.model === 'x/crash') process.exit(3);
      send({ id, type: 'start', stop: ['<|im_end|>', '<|endoftext|>'] });
      if (request.model === 'x/slow') {
        timers.set(id, setInterval(() => send({ id, type: 'text', text: 'tick ' }), 5));
        return;
      }
      for (const text of ['<thi', 'nk>plan', 'ning</think>\n\n', 'Hel', 'lo ', request.messages.at(-1).content, '<|im', '_end|>junk']) {
        send({ id, type: 'text', text });
      }
      return send({ id, type: 'result', value: { inputTokens: 12, outputTokens: 7 } });
    }
    default:
      return send({ id, type: 'error', code: 'invalid-request', message: 'Unknown op.' });
  }
});
