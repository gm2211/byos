import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageRoot = new URL('../', import.meta.url);
const args = process.argv.slice(2);
const directoryFlag = args.indexOf('--engine-dir');
const base = directoryFlag < 0 ? new URL('engine/', packageRoot)
  : pathToFileURL(resolve(args[directoryFlag + 1]) + '/');
const artifactFiles = ['motive_browser_tls.js', 'motive_browser_tls.d.ts', 'motive_browser_tls_bg.wasm', 'motive_browser_tls_bg.wasm.d.ts'];
const sourceFiles = ['Cargo.toml', 'Cargo.lock', 'src/lib.rs'];
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const module = new WebAssembly.Module(readFileSync(new URL('motive_browser_tls_bg.wasm', base)));
if (WebAssembly.Module.imports(module).some(item => item.module === 'env')) throw new Error('Unresolved native WASM imports.');

const manifestFile = new URL('build-manifest.json', base);
if (args.includes('--write')) {
  const sources = [...sourceFiles.map(file => `packages/browser-tls/rust/${file}`), 'packages/browser-tls/scripts/build-engine.sh'];
  const manifest = {
    format: 1, llvm: '23.1.0', rustToolchain: '1.94.1', wasmBindgen: '0.2.128', tls: 'TLSv1.3', trust: 'webpki-roots 1.0.9',
    files: Object.fromEntries([
      ...sources.map(file => [file, hash(new URL(file.replace('packages/browser-tls/', ''), packageRoot))]),
      ...artifactFiles.map(file => [`packages/browser-tls/engine/${file}`, hash(new URL(file, base))]),
    ]),
  };
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
}
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
for (const file of artifactFiles) {
  const entries = Object.entries(manifest.files).filter(([path]) => path.endsWith('/' + file));
  if (entries.length !== 1 || entries[0][1] !== hash(new URL(file, base))) throw new Error(`Reviewed TLS engine hash mismatch: ${file}`);
}
for (const file of sourceFiles) {
  const expected = manifest.files[`packages/browser-tls/rust/${file}`] ?? manifest.files[`browser-tls/${file}`];
  if (!expected || expected !== hash(new URL(`rust/${file}`, packageRoot))) throw new Error(`Reviewed TLS source hash mismatch: ${file}`);
}
if (manifest.files['packages/browser-tls/scripts/build-engine.sh']
  && manifest.files['packages/browser-tls/scripts/build-engine.sh'] !== hash(new URL('scripts/build-engine.sh', packageRoot))) {
  throw new Error('Reviewed TLS build script hash mismatch.');
}
console.log('Reviewed TLS source and engine hashes verified.');
