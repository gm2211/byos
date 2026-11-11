#!/usr/bin/env node
// Manual end-to-end check on an Apple silicon Mac, from packages/mlx-local, after `npm run build:bridge` and `npm run build`:
//   node scripts/smoke.mjs [publisher/model] [prompt]
// Downloads the model if needed, streams one answer, prints timing. Uses the default models dir
// unless BYOS_MLX_MODELS_DIR is set.
import { createMlxLocal } from '../dist/index.js';

const model = process.argv[2] ?? 'mlx-community/Qwen3-0.6B-4bit';
const prompt = process.argv[3] ?? 'In one sentence, why is the sky blue?';
const local = createMlxLocal({ modelsDir: process.env.BYOS_MLX_MODELS_DIR });

try {
  console.log('status', JSON.stringify(await local.status()));
  const downloaded = await local.listDownloaded();
  if (!downloaded.some(entry => entry.id === model)) {
    let shown = -1;
    await local.download(model, {
      onProgress: fraction => {
        const pct = Math.floor(fraction * 10) * 10;
        if (pct !== shown) { shown = pct; process.stdout.write(`download ${pct}%\n`); }
      },
    });
  }
  console.log('models', JSON.stringify(await local.listDownloaded()));
  const started = performance.now();
  let first;
  for await (const event of local.provider('mlx').stream({ model, messages: [{ role: 'user', content: prompt }] })) {
    if (event.type === 'text') { first ??= performance.now(); process.stdout.write(event.text); }
    else if (event.type === 'reasoning') process.stdout.write(`[reasoning] ${event.text}`);
    else if (event.type === 'usage') process.stdout.write(`\nusage ${JSON.stringify(event)}`);
  }
  console.log(`\nfirst token ${Math.round((first ?? performance.now()) - started)} ms, total ${Math.round(performance.now() - started)} ms`);

  const controller = new AbortController();
  let chunks = 0;
  try {
    for await (const event of local.mlx.stream({ model, messages: [{ role: 'user', content: 'Count from 1 to 500.' }], signal: controller.signal })) {
      if (event.type === 'text' && ++chunks === 5) controller.abort();
    }
  } catch (error) {
    console.log(`abort after ${chunks} chunks -> ${error.name}`);
  }

  const fm = local.provider('foundation-models');
  if (fm.availability().available) {
    process.stdout.write('apple: ');
    for await (const event of local.foundationModels.stream({ model: 'apple-foundation-model', messages: [{ role: 'user', content: prompt }] })) {
      if (event.type === 'text') process.stdout.write(event.text);
    }
    console.log();
  } else {
    console.log('apple unavailable:', fm.availability().reason);
  }
} finally {
  local.close();
}
