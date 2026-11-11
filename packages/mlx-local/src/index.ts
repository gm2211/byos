import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { CatalogModel, ChatEvent, ChatRequest, ProviderAvailability } from '@byos/core';
import {
  createOnDeviceProvider,
  type OnDeviceBridge,
  type OnDeviceProvider,
  type OnDeviceProviderId,
  type OnDeviceRuntime,
} from '@byos/providers';
import { StreamShaper } from './shape.js';

export { StreamShaper } from './shape.js';

/** The protocol version this client speaks; `byos-mlx` reports its own in `hello`. */
export const MLX_PROTOCOL_VERSION = 1;

/** Tested MLX models (from Skim's chat eval), smallest first. Use for a download picker. */
export const RECOMMENDED_MLX_MODELS: readonly (CatalogModel & { approxBytes: number })[] = [
  { id: 'mlx-community/Qwen3.5-2B-4bit', name: 'Qwen3.5 2B', approxBytes: 1_300_000_000 },
  { id: 'mlx-community/gemma-4-e2b-it-4bit', name: 'Gemma 4 E2B', approxBytes: 2_100_000_000 },
  { id: 'mlx-community/Qwen3.5-4B-4bit', name: 'Qwen3.5 4B', recommended: true, approxBytes: 2_500_000_000 },
  { id: 'mlx-community/gemma-4-e4b-it-4bit', name: 'Gemma 4 E4B', approxBytes: 3_500_000_000 },
  { id: 'mlx-community/Qwen3.5-9B-4bit', name: 'Qwen3.5 9B', approxBytes: 5_300_000_000 },
];

/** The single model Apple's Foundation Models framework exposes. */
export const APPLE_FOUNDATION_MODEL: CatalogModel = { id: 'apple-foundation-model', name: 'Apple Intelligence' };

export type MlxLocalErrorCode =
  | 'unavailable'
  | 'invalid-model'
  | 'model-not-downloaded'
  | 'invalid-request'
  | 'protocol'
  | 'aborted'
  | 'failed';

/** Errors carry a fixed code. `message` is the helper's own wording, never prompt or model text. */
export class MlxLocalError extends Error {
  readonly code: MlxLocalErrorCode;

  constructor(code: MlxLocalErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = code === 'aborted' ? 'AbortError' : 'MlxLocalError';
  }
}

export type DownloadedModel = { id: string; bytes: number };

export type MlxLocalStatus = { mlx: ProviderAvailability; foundationModels: ProviderAvailability };

export type MlxLocalOptions = {
  /** Path to the `byos-mlx` helper. Default: `bin/byos-mlx` in this package (see scripts/build-bridge.sh). */
  binaryPath?: string;
  /**
   * Model storage root; models live in `<modelsDir>/models/<publisher>/<model>`.
   * Default: `~/Library/Application Support/BYOS/mlx`. Point two apps at one root to share downloads.
   */
  modelsDir?: string;
  /** Stop the helper (and free the loaded model's memory) after this long without requests. Default 5 minutes; 0 keeps it. */
  idleTimeoutMs?: number;
  /** Sampling overrides. Defaults are per model (Skim's tuned presets). */
  maxTokens?: number;
  temperature?: number;
  /** For tests: the platform check. Default: `process.platform === 'darwin' && process.arch === 'arm64'`. */
  platformSupported?: boolean;
};

export interface MlxLocal {
  /** Pass to `createOnDeviceProvider` / `onDeviceProvidersFor`. Empty off Apple silicon macOS. */
  readonly runtime: OnDeviceRuntime;
  /** Host bridges for the `mlx` and `foundation-models` on-device providers. */
  readonly mlx: OnDeviceBridge;
  readonly foundationModels: OnDeviceBridge;
  /** Bound on-device providers, ready for a picker. */
  provider(id: 'mlx' | 'foundation-models'): OnDeviceProvider;
  /** Asks the helper what it can run and refreshes `availability()` on both bridges. */
  status(signal?: AbortSignal): Promise<MlxLocalStatus>;
  listDownloaded(signal?: AbortSignal): Promise<DownloadedModel[]>;
  download(model: string, options?: { signal?: AbortSignal; onProgress?: (fraction: number) => void }): Promise<void>;
  delete(model: string, signal?: AbortSignal): Promise<void>;
  /** Stops the helper. The next call starts it again. */
  close(): void;
}

type Line = { id?: unknown; type?: unknown; [key: string]: unknown };
type Pending = { onLine(line: Line): void; fail(error: Error): void };

const MODEL_ID = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const ERROR_CODES = new Set<MlxLocalErrorCode>(['unavailable', 'invalid-model', 'model-not-downloaded', 'invalid-request', 'aborted', 'failed']);

function defaultBinaryPath(): string {
  return fileURLToPath(new URL('../bin/byos-mlx', import.meta.url));
}

function defaultModelsDir(): string {
  return path.join(homedir(), 'Library', 'Application Support', 'BYOS', 'mlx');
}

function isModelId(model: unknown): model is string {
  return typeof model === 'string' && model.length <= 128 && MODEL_ID.test(model)
    && !model.split('/').some(part => part === '.' || part === '..');
}

function validModel(model: string): string {
  if (!isModelId(model)) {
    throw new MlxLocalError('invalid-model', 'Expected a Hugging Face model id like publisher/model.');
  }
  return model;
}

function abortError(): MlxLocalError {
  return new MlxLocalError('aborted', 'The operation was aborted.');
}

function lineError(line: Line): MlxLocalError {
  const code = ERROR_CODES.has(line.code as MlxLocalErrorCode) ? line.code as MlxLocalErrorCode : 'failed';
  const message = typeof line.message === 'string' && line.message.length <= 500 ? line.message : 'The on-device model failed.';
  return new MlxLocalError(code, message);
}

function availabilityFrom(value: unknown): ProviderAvailability {
  const record = value as { available?: unknown; reason?: unknown } | undefined;
  if (record?.available === true) return { available: true };
  return { available: false, reason: typeof record?.reason === 'string' ? record.reason : 'Unavailable.' };
}

function displayName(id: string): string {
  return RECOMMENDED_MLX_MODELS.find(model => model.id === id)?.name ?? id.split('/')[1]!.replace(/-/g, ' ');
}

/** Runs MLX models (and Apple's on-device model) on this Mac through the `byos-mlx` helper. */
export function createMlxLocal(options: MlxLocalOptions = {}): MlxLocal {
  const binaryPath = options.binaryPath ?? defaultBinaryPath();
  const modelsDir = options.modelsDir ?? defaultModelsDir();
  const idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60_000;
  const platformSupported = options.platformSupported ?? (process.platform === 'darwin' && process.arch === 'arm64');
  const runtime: OnDeviceRuntime = {
    kind: 'native',
    supportedProviders: platformSupported ? ['mlx', 'foundation-models'] : [],
  };

  let child: ChildProcessWithoutNullStreams | undefined;
  let nextId = 1;
  let idleTimer: NodeJS.Timeout | undefined;
  const pending = new Map<string, Pending>();
  let lastStatus: MlxLocalStatus | undefined;

  const staticAvailability = (): ProviderAvailability => {
    if (!platformSupported) return { available: false, reason: 'On-device MLX needs an Apple silicon Mac.' };
    if (!existsSync(binaryPath)) return { available: false, reason: 'The byos-mlx helper is not installed. Build it with scripts/build-bridge.sh.' };
    return { available: true };
  };

  const failAll = (error: Error) => {
    const waiting = [...pending.values()];
    pending.clear();
    for (const entry of waiting) entry.fail(error);
  };

  const scheduleIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    if (idleTimeoutMs > 0 && pending.size === 0 && child) {
      idleTimer = setTimeout(() => { if (pending.size === 0) stop(); }, idleTimeoutMs);
      idleTimer.unref();
    }
  };

  const stop = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    const running = child;
    child = undefined;
    if (running) {
      running.stdin.end();
      running.kill();
    }
    failAll(new MlxLocalError('unavailable', 'The on-device runtime stopped.'));
  };

  const ensureChild = (): ChildProcessWithoutNullStreams => {
    if (child) return child;
    const ready = staticAvailability();
    if (!ready.available) throw new MlxLocalError('unavailable', ready.reason);
    // stderr is ignored: the helper never writes prompts there, and MLX's own noise is not useful.
    const started = spawn(binaryPath, ['--models-dir', modelsDir], { stdio: ['pipe', 'pipe', 'ignore'] }) as unknown as ChildProcessWithoutNullStreams;
    child = started;
    started.on('error', () => {
      if (child === started) { child = undefined; failAll(new MlxLocalError('unavailable', 'The byos-mlx helper could not start.')); }
    });
    started.on('exit', () => {
      if (child === started) { child = undefined; failAll(new MlxLocalError('unavailable', 'The byos-mlx helper exited.')); }
    });
    started.stdin.on('error', () => {});
    createInterface({ input: started.stdout }).on('line', raw => {
      let line: Line;
      try { line = JSON.parse(raw) as Line; } catch { return; }
      if (!line || typeof line !== 'object' || typeof line.id !== 'string') return;
      pending.get(line.id)?.onLine(line);
    });
    return started;
  };

  /** Sends one request; `onEvent` sees non-terminal lines. Resolves with the result's `value`. */
  const call = (body: Record<string, unknown>, signal?: AbortSignal, onEvent?: (line: Line) => void): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      let process_: ChildProcessWithoutNullStreams;
      try { process_ = ensureChild(); } catch (error) { return reject(error); }
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
      const id = String(nextId++);
      const onAbort = () => {
        if (!pending.delete(id)) return;
        process_.stdin.write(`${JSON.stringify({ id: `cancel-${id}`, op: 'cancel', target: id })}\n`);
        reject(abortError());
        scheduleIdle();
      };
      const finish = () => { signal?.removeEventListener('abort', onAbort); pending.delete(id); scheduleIdle(); };
      pending.set(id, {
        onLine(line) {
          if (line.type === 'result') { finish(); resolve((line.value ?? {}) as Record<string, unknown>); }
          else if (line.type === 'error') { finish(); reject(lineError(line)); }
          else onEvent?.(line);
        },
        fail(error) { signal?.removeEventListener('abort', onAbort); reject(error); },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      process_.stdin.write(`${JSON.stringify({ id, ...body })}\n`);
    });

  async function* generate(engine: OnDeviceProviderId, request: ChatRequest): AsyncGenerator<ChatEvent> {
    const queue: ChatEvent[] = [];
    let wake: (() => void) | undefined;
    let settled: { error?: unknown; value?: Record<string, unknown> } | undefined;
    let shaper: StreamShaper | undefined;
    const notify = () => { const resolve = wake; wake = undefined; resolve?.(); };
    const internal = new AbortController();
    const onOuterAbort = () => internal.abort();
    request.signal?.addEventListener('abort', onOuterAbort, { once: true });
    if (request.signal?.aborted) internal.abort();

    const body: Record<string, unknown> = {
      op: 'generate',
      engine,
      messages: request.messages.map(({ role, content }) => ({ role, content })),
    };
    if (engine === 'mlx') body.model = validModel(request.model);
    if (options.maxTokens !== undefined) body.maxTokens = options.maxTokens;
    if (options.temperature !== undefined) body.temperature = options.temperature;

    call(body, internal.signal, line => {
      if (line.type === 'start') {
        shaper = new StreamShaper(Array.isArray(line.stop) ? line.stop.filter((s): s is string => typeof s === 'string' && s.length > 0) : []);
      } else if (line.type === 'text' && typeof line.text === 'string') {
        shaper ??= new StreamShaper([]);
        queue.push(...shaper.push(line.text));
        notify();
      }
    }).then(value => { settled = { value }; notify(); }, error => { settled = { error }; notify(); });

    try {
      while (true) {
        if (queue.length) { yield queue.shift()!; continue; }
        if (settled) break;
        await new Promise<void>(resolve => { wake = resolve; });
      }
      if (settled.error) throw settled.error;
      for (const event of shaper?.end() ?? []) yield event;
      const value = settled.value ?? {};
      const usage: ChatEvent = { type: 'usage' };
      if (typeof value.inputTokens === 'number') usage.inputTokens = value.inputTokens;
      if (typeof value.outputTokens === 'number') usage.outputTokens = value.outputTokens;
      if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) yield usage;
      yield { type: 'done' };
    } finally {
      request.signal?.removeEventListener('abort', onOuterAbort);
      // A consumer that stops reading early cancels the generation.
      if (!settled) internal.abort();
    }
  }

  const bridgeFor = (id: 'mlx' | 'foundation-models'): OnDeviceBridge => ({
    availability() {
      const ready = staticAvailability();
      if (!ready.available || !lastStatus) return ready;
      return id === 'mlx' ? lastStatus.mlx : lastStatus.foundationModels;
    },
    async listModels(signal) {
      if (id === 'foundation-models') return [APPLE_FOUNDATION_MODEL];
      const models = await listDownloaded(signal);
      const recommended = new Set(RECOMMENDED_MLX_MODELS.filter(model => model.recommended).map(model => model.id));
      return models.map(model => ({ id: model.id, name: displayName(model.id), ...(recommended.has(model.id) ? { recommended: true } : {}) }));
    },
    stream: request => generate(id, request),
  });

  const listDownloaded = async (signal?: AbortSignal): Promise<DownloadedModel[]> => {
    const value = await call({ op: 'list' }, signal);
    const models = Array.isArray(value.models) ? value.models : [];
    return models
      .filter((model): model is DownloadedModel => isModelId(model?.id) && typeof model.bytes === 'number')
      .map(({ id, bytes }) => ({ id, bytes }));
  };

  const mlx = bridgeFor('mlx');
  const foundationModels = bridgeFor('foundation-models');

  return {
    runtime,
    mlx,
    foundationModels,
    provider: id => createOnDeviceProvider(id, { runtime, bridge: id === 'mlx' ? mlx : foundationModels }),
    async status(signal) {
      const ready = staticAvailability();
      if (!ready.available) return { mlx: ready, foundationModels: ready };
      const value = await call({ op: 'status' }, signal);
      lastStatus = { mlx: availabilityFrom(value.mlx), foundationModels: availabilityFrom(value.foundationModels) };
      return lastStatus;
    },
    listDownloaded,
    async download(model, { signal, onProgress } = {}) {
      await call({ op: 'download', model: validModel(model) }, signal, line => {
        if (line.type === 'progress' && typeof line.fraction === 'number' && Number.isFinite(line.fraction)) {
          onProgress?.(Math.min(Math.max(line.fraction, 0), 1));
        }
      });
    },
    async delete(model, signal) {
      await call({ op: 'delete', model: validModel(model) }, signal);
    },
    close: stop,
  };
}
