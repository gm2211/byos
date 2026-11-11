# @byos/mlx-local

Runs language models **on this Mac**: any MLX model from Hugging Face (`mlx-community/*`) on the Apple silicon GPU, and Apple's own on-device model (Apple Intelligence) on macOS 26+. Nothing leaves the machine except the one-time model download from `huggingface.co`. **Node-only**, Apple silicon only.

It is the engine Skim ships, lifted out: `swift/` is Skim's `SkimMLXEngine` (mlx-swift 0.32.3, mlx-swift-lm 3.32.3, swift-transformers 1.3.4, Skim's per-model sampling presets and template checks) plus a `byos-mlx` helper process modelled on Skim's macOS AI bridge. The Node side spawns the helper, talks newline-delimited JSON to it, and plugs it into the `mlx` and `foundation-models` providers from `@byos/providers`.

```
your app ──OnDeviceProvider──▶ @byos/mlx-local ──stdin/stdout JSONL──▶ byos-mlx (Swift) ──▶ MLX on the GPU
                                                                                      └──▶ Apple Foundation Models
```

## Build the helper (once per checkout)

```sh
npm run build:bridge -w @byos/mlx-local   # needs Xcode; writes packages/mlx-local/bin/
```

That produces `bin/byos-mlx` (ad-hoc signed), `bin/mlx.metallib` (MLX's GPU kernels; SwiftPM cannot compile Metal, so the script does it with `xcrun metal`), and `bin/swift-transformers_Hub.bundle`. Keep the three together. To ship inside an app, copy them into the app bundle and pass `binaryPath`.

## Use it

```ts
import { createMlxLocal, RECOMMENDED_MLX_MODELS } from '@byos/mlx-local';
import { onDeviceProvidersFor } from '@byos/providers';

const local = createMlxLocal();                 // options: binaryPath, modelsDir, idleTimeoutMs, maxTokens, temperature
await local.status();                           // { mlx: {available}, foundationModels: {available | reason} }
onDeviceProvidersFor(local.runtime);            // ['mlx', 'foundation-models'] on Apple silicon, [] elsewhere

await local.download('mlx-community/Qwen3.5-4B-4bit', { onProgress: f => bar(f) });
const mlx = local.provider('mlx');              // an OnDeviceProvider
for await (const event of mlx.stream({ model: 'mlx-community/Qwen3.5-4B-4bit', messages })) {
  if (event.type === 'text') write(event.text);  // also 'reasoning', 'usage', 'done'
}
local.close();
```

- `listModels()` on the `mlx` provider returns the models **already downloaded** (never a hard-coded list). `RECOMMENDED_MLX_MODELS` is the download picker: Qwen3.5 2B/4B/9B and Gemma 4 E2B/E4B, the models Skim's chat eval tuned presets for. Any other MLX chat model also works with default sampling.
- Models live in `<modelsDir>/models/<publisher>/<model>` (default `~/Library/Application Support/BYOS/mlx`). That is the Hugging Face snapshot layout Skim uses under `~/Documents/huggingface`, so `modelsDir: ~/Documents/huggingface` shares Skim's downloads.
- Streaming: text arrives token by token. Leading `<think>…</think>` (Qwen) and `<|channel>…<channel|>` (Gemma 4) blocks become `reasoning` events; end-of-turn markers are cut. Thinking is switched off in templates that support the switch.
- Abort `request.signal`, or stop iterating, and the helper stops decoding.
- One model stays loaded; switching models reloads. After `idleTimeoutMs` (default 5 minutes) with no requests the helper exits, which frees the model's memory; the next call restarts it.
- Errors are `MlxLocalError` with a fixed `code` (`unavailable`, `invalid-model`, `model-not-downloaded`, `invalid-request`, `aborted`, `failed`). Through the `@byos/providers` wrapper, non-abort errors surface as the provider's generic unavailable message by design; call the bridge (`local.mlx.stream`) directly to see the code.
- Model ids must look like `publisher/model`; anything else is refused before it reaches the helper or the filesystem.
- Prompts and output never go to stderr, logs, or diagnostics. The helper's stderr is discarded.

## Helper protocol (version 1)

One JSON object per line. Each request has a client-chosen `id` and an `op`; the helper answers with zero or more interim lines and then exactly one `result` or `error` for that id. Requests run concurrently; generations share the loaded model and run one at a time.

| op | request fields | interim lines | result `value` |
| --- | --- | --- | --- |
| `hello` | | | `{ protocol, modelsDir }` |
| `status` | | | `{ mlx: {available, reason?}, foundationModels: {available, reason?} }` |
| `list` | | | `{ models: [{ id, bytes }] }` |
| `download` | `model` | `{type:'progress', fraction}` | `{}` |
| `delete` | `model` | | `{}` |
| `generate` | `engine: 'mlx' \| 'foundation-models'`, `model` (mlx), `messages`, `maxTokens?`, `temperature?`, `topP?` | `{type:'start', stop:[…]}`, then `{type:'text', text}` | `{ inputTokens, outputTokens, timeToFirstTokenSeconds, decodeTokensPerSecond, peakMemoryBytes }` |
| `cancel` | `target` (an id) | | the target ends with `{type:'error', code:'aborted'}` |

Errors: `{ id, type: 'error', code, message }`. Closing stdin ends the helper. Run it with `--models-dir <path>`.

Non-Node hosts (Tauri, Electron main, a Swift app) can drive the same helper over this protocol, or link the `ByosMLX` Swift library directly.

## Limits

- Apple silicon macOS 14+ only. iOS apps should link `swift/` (`ByosMLX`) in-process, as Skim's iOS app does; there is no subprocess on iOS.
- CI builds the helper on a macOS runner but cannot run a model there (no usable Metal GPU in hosted runners). Generation is verified by hand with `scripts/smoke.mjs` (run from `packages/mlx-local`); on an M5 MacBook, Qwen3.5-2B-4bit streamed its first token in about 4.4 s from a cold start (model load included), and Apple Intelligence answered through the same helper.
- Skim's article-prefix KV-cache reuse is not ported yet; every request prefills its whole prompt.
