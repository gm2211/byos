import { AsyncEntry } from '@napi-rs/keyring';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ChatGptError, checkSignal } from './errors.js';

/** Trusted runtime injection only. write must atomically replace the complete secret record. */
export interface CredentialStore { read(): Promise<string | null>; write(value: string): Promise<void> }
export function keychainStore(namespace: string): CredentialStore {
  const entry = () => {
    if (process.platform !== 'darwin') throw new ChatGptError('storage-unavailable');
    return new AsyncEntry(`byos.chatgpt.${namespace}`, 'registrations-v1');
  };
  return {
    async read() { try { return (await entry().getPassword()) ?? null; } catch { throw new ChatGptError('storage-unavailable'); } },
    async write(value) { try { await entry().setPassword(value); } catch { throw new ChatGptError('storage-unavailable'); } },
  };
}

// Files contain only a process ID. Credentials never enter the filesystem.
// The same namespace must use the same lock directory in every local process.
export function processLock(namespace: string, directory?: string) {
  const root = directory ?? join(tmpdir(), `byos-chatgpt-${process.getuid?.() ?? 'user'}`);
  const path = join(root, createHash('sha256').update(namespace).digest('hex') + '.lock');
  return async function locked<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const stat = await lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error();
    } catch { throw new ChatGptError('storage-unavailable'); }
    const deadline = Date.now() + 45_000;
    for (;;) {
      checkSignal(signal);
      try { await mkdir(path, { mode: 0o700 }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new ChatGptError('storage-unavailable');
        // Reclaim only a demonstrably dead process. A missing/malformed owner remains locked.
        try {
          const pid = Number(await readFile(join(path, 'pid'), 'utf8'));
          if (Number.isSafeInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
                // Serialize dead-lock recovery through a separate mkdir. Never remove a live replacement.
                const recovery = `${path}.recover`;
                try {
                  await mkdir(recovery, { mode: 0o700 });
                  try {
                    if (Number(await readFile(join(path, 'pid'), 'utf8')) === pid) await rm(path, { recursive: true });
                  } finally { await rm(recovery, { recursive: true, force: true }); }
                  continue;
                } catch { /* A second process is recovering or has replaced this lock. */ }
              }
            }
          }
        } catch { /* Wait for the acquiring process to finish writing its owner. */ }
        if (Date.now() >= deadline) throw new ChatGptError('busy');
        await delay(40);
      }
    }
    try { await writeFile(join(path, 'pid'), String(process.pid), { mode: 0o600 }); return await run(); }
    finally { await rm(path, { recursive: true, force: true }); }
  };
}
