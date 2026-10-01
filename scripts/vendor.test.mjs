import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { vendor } from './vendor.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'byos-vendor-'));
  const source = path.join(root, 'source');
  await mkdir(source, { recursive: true });
  const runGit = (args) => {
    const result = spawnSync('git', ['-C', source, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const addPackage = async (id, manifest, sourceText = 'export const value = 1;\n') => {
    const dir = path.join(source, 'packages', id);
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(path.join(dir, 'package.json'), `${JSON.stringify({ name: `@byos/${id}`, version: '1.0.0', type: 'module', ...manifest }, null, 2)}\n`);
    await writeFile(path.join(dir, 'src', 'index.ts'), sourceText);
  };
  await addPackage('core', {});
  await addPackage('providers', { dependencies: { '@byos/core': 'file:../core' } }, "import { value } from '@byos/core';\nexport const providerValue = value;\n");
  await writeFile(path.join(source, 'packages', 'providers', 'package-lock.json'), `${JSON.stringify({
    name: '@byos/providers',
    packages: {
      '': { dependencies: { '@byos/core': 'file:../core' } },
      '../core': { resolved: '../core' },
    },
  }, null, 2)}\n`);
  await addPackage('codex', { dependencies: { '@byos/providers': 'file:../providers' } }, "import { providerValue } from '@byos/providers';\nexport const codexValue = providerValue;\n");
  await addPackage('unused', {});

  await writeFile(path.join(source, '.gitignore'), '.env\n');
  runGit(['init', '--quiet']);
  runGit(['config', 'user.name', 'BYOS Vendor Test']);
  runGit(['config', 'user.email', 'byos-vendor@example.invalid']);
  runGit(['add', '.']);
  runGit(['commit', '--quiet', '-m', 'fixture']);
  const ref = runGit(['rev-parse', 'HEAD']);
  return { root, source, ref, addPackage };
}

function options(fx, overrides = {}) {
  return {
    source: fx.source,
    ref: fx.ref,
    out: path.join(fx.root, 'consumer', 'vendor'),
    mode: 'packages',
    packages: ['codex'],
    namePrefix: 'site-',
    engine: 'omit',
    bundleName: 'byos.js',
    ...overrides,
  };
}

async function addValidBrowserTlsEngine(fx) {
  await fx.addPackage('browser-tls', {});
  const engineDir = path.join(fx.source, 'packages', 'browser-tls', 'engine');
  await mkdir(engineDir, { recursive: true });
  const names = ['motive_browser_tls.js', 'motive_browser_tls.d.ts', 'motive_browser_tls_bg.wasm', 'motive_browser_tls_bg.wasm.d.ts'];
  const files = {};
  for (const name of names) {
    const contents = Buffer.from(`fixture:${name}`);
    await writeFile(path.join(engineDir, name), contents);
    files[`web/src/generated/browser-tls/${name}`] = createHash('sha256').update(contents).digest('hex');
  }
  await writeFile(path.join(engineDir, 'build-manifest.json'), JSON.stringify({ files }));
  for (const args of [['add', '.'], ['commit', '--quiet', '-m', 'valid engine fixture']]) {
    const result = spawnSync('git', ['-C', fx.source, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  fx.ref = spawnSync('git', ['-C', fx.source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  return engineDir;
}

test('SHA-pinned package vendoring includes transitive dependencies and rewrites local paths', async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  const result = await vendor(options(fx));
  assert.equal(result.commit, fx.ref);
  assert.deepEqual(result.selected, ['codex', 'core', 'providers']);
  const consumer = path.dirname(result.outDir);
  const codex = JSON.parse(await readFile(path.join(result.outDir, 'site-codex', 'package.json'), 'utf8'));
  const providers = JSON.parse(await readFile(path.join(result.outDir, 'site-providers', 'package.json'), 'utf8'));
  const providersLock = JSON.parse(await readFile(path.join(result.outDir, 'site-providers', 'package-lock.json'), 'utf8'));
  assert.equal(codex.dependencies['@byos/providers'], 'file:../site-providers');
  assert.equal(providers.dependencies['@byos/core'], 'file:../site-core');
  assert.equal(providersLock.packages[''].dependencies['@byos/core'], 'file:../site-core');
  assert.deepEqual(providersLock.packages['../site-core'], { resolved: '../site-core' });
  assert.equal(await readFile(path.join(result.outDir, 'REVISION'), 'utf8'), [
    `commit=${fx.ref}`, 'sourcePath=packages', 'mode=packages', 'packages=codex,core,providers', 'namePrefix=site-', 'engine=omit', '',
  ].join('\n'));
  assert.equal(consumer.endsWith('consumer'), true);
});

test('stale generated packages are removed while unrelated consumer files survive', async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  const out = options(fx).out;
  await mkdir(path.join(out, 'site-unused'), { recursive: true });
  await writeFile(path.join(out, 'site-unused', 'old.txt'), 'generated old package');
  await mkdir(path.join(out, 'site-not-a-package'), { recursive: true });
  await writeFile(path.join(out, 'site-not-a-package', 'keep.txt'), 'consumer owned');
  await writeFile(path.join(out, 'consumer-note.txt'), 'keep');
  await vendor(options(fx));
  await assert.rejects(readFile(path.join(out, 'site-unused', 'old.txt')));
  assert.equal(await readFile(path.join(out, 'site-not-a-package', 'keep.txt'), 'utf8'), 'consumer owned');
  assert.equal(await readFile(path.join(out, 'consumer-note.txt'), 'utf8'), 'keep');
});

test('engine validation failure preserves current output and revision', async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  await fx.addPackage('browser-tls', {});
  const engineDir = path.join(fx.source, 'packages', 'browser-tls', 'engine');
  await mkdir(engineDir, { recursive: true });
  const names = ['motive_browser_tls.js', 'motive_browser_tls.d.ts', 'motive_browser_tls_bg.wasm', 'motive_browser_tls_bg.wasm.d.ts'];
  const files = {};
  for (const name of names) {
    await writeFile(path.join(engineDir, name), `fixture:${name}`);
    files[`web/src/generated/browser-tls/${name}`] = '0'.repeat(64);
  }
  await writeFile(path.join(engineDir, 'build-manifest.json'), JSON.stringify({ files }));
  const result = spawnSync('git', ['-C', fx.source, 'add', '.'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const commit = spawnSync('git', ['-C', fx.source, 'commit', '--quiet', '-m', 'bad engine fixture'], { encoding: 'utf8' });
  assert.equal(commit.status, 0, commit.stderr);
  fx.ref = spawnSync('git', ['-C', fx.source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const out = options(fx).out;
  const revision = path.join(fx.root, 'consumer', 'release.txt');
  await mkdir(path.join(out, 'site-core'), { recursive: true });
  await writeFile(path.join(out, 'site-core', 'marker.txt'), 'old output');
  await writeFile(revision, 'old revision');
  await assert.rejects(vendor(options(fx, { packages: ['core', 'browser-tls'], engine: 'include', revision })), /hash mismatch/);
  assert.equal(await readFile(path.join(out, 'site-core', 'marker.txt'), 'utf8'), 'old output');
  assert.equal(await readFile(revision, 'utf8'), 'old revision');
});

test('ignored and dirty worktree files never enter the pinned source export', async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  await writeFile(path.join(fx.source, 'packages', 'core', 'src', 'index.ts'), 'export const value = 999;\n');
  await writeFile(path.join(fx.source, 'packages', 'core', '.env'), 'fixture-secret-must-not-copy');
  const result = await vendor(options(fx));
  const copiedCore = path.join(result.outDir, 'site-core');
  assert.equal(await readFile(path.join(copiedCore, 'src', 'index.ts'), 'utf8'), 'export const value = 1;\n');
  await assert.rejects(readFile(path.join(copiedCore, '.env')));
});

test('bundle mode emits a static ESM file when esbuild is installed', async (t) => {
  try { await import('esbuild'); } catch { t.skip('esbuild is installed by the root tooling workspace'); return; }
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  const unrelatedEngine = path.join(options(fx).out, 'engine', 'consumer-owned.txt');
  await mkdir(path.dirname(unrelatedEngine), { recursive: true });
  await writeFile(unrelatedEngine, 'consumer-owned engine directory');
  const result = await vendor(options(fx, { mode: 'bundle' }));
  const bundle = await readFile(path.join(result.outDir, 'byos.js'), 'utf8');
  assert.match(bundle, /codexValue/);
  assert.doesNotMatch(bundle, /from ['"]@byos\//);
  assert.equal(await readFile(unrelatedEngine, 'utf8'), 'consumer-owned engine directory');
});

test('independent pinned exports produce byte-identical bundles without temporary paths', async (t) => {
  try { await import('esbuild'); } catch { t.skip('esbuild is installed by the root tooling workspace'); return; }
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  const first = await vendor(options(fx, { mode: 'bundle', out: path.join(fx.root, 'consumer-a', 'vendor') }));
  const second = await vendor(options(fx, { mode: 'bundle', out: path.join(fx.root, 'consumer-b', 'vendor') }));
  const firstBundle = await readFile(path.join(first.outDir, 'byos.js'), 'utf8');
  const secondBundle = await readFile(path.join(second.outDir, 'byos.js'), 'utf8');
  assert.equal(firstBundle, secondBundle);
  assert.doesNotMatch(firstBundle, /byos-vendor-source-|byos-vendor-[^/]*|byos-entry\.ts/);
  assert.doesNotMatch(firstBundle, new RegExp(fx.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('canonical path checks reject output or revision paths aliased into source', async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  const sourceAlias = path.join(fx.root, 'source-alias');
  await symlink(fx.source, sourceAlias);
  await assert.rejects(vendor(options(fx, { out: path.join(sourceAlias, 'consumer-output') })), /outside the source clone/);
  await assert.rejects(vendor(options(fx, { revision: path.join(sourceAlias, 'consumer-revision') })), /overlap the source clone/);
  await assert.rejects(readFile(path.join(fx.source, 'consumer-output')));
});

test('bundle omission removes a previously managed engine and records the omission', async (t) => {
  try { await import('esbuild'); } catch { t.skip('esbuild is installed by the root tooling workspace'); return; }
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  await addValidBrowserTlsEngine(fx);
  const settings = options(fx, { mode: 'bundle', packages: ['browser-tls'], engine: 'include' });
  const included = await vendor(settings);
  const engine = path.join(included.outDir, 'engine', 'motive_browser_tls.js');
  const originalEngine = await readFile(engine, 'utf8');
  await vendor({ ...settings, engine: 'omit' });
  await assert.rejects(readFile(engine));
  assert.match(await readFile(path.join(included.outDir, 'REVISION'), 'utf8'), /engine=omit/);
  assert.notEqual(originalEngine, '');
});

test('bundle engine omission restores managed engine and bundle if revision install fails', async (t) => {
  try { await import('esbuild'); } catch { t.skip('esbuild is installed by the root tooling workspace'); return; }
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  await addValidBrowserTlsEngine(fx);
  const settings = options(fx, { mode: 'bundle', packages: ['browser-tls'], engine: 'include' });
  const included = await vendor(settings);
  const bundlePath = path.join(included.outDir, 'byos.js');
  const revisionPath = path.join(included.outDir, 'REVISION');
  const enginePath = path.join(included.outDir, 'engine', 'motive_browser_tls.js');
  const before = {
    bundle: await readFile(bundlePath, 'utf8'),
    engine: await readFile(enginePath, 'utf8'),
    revision: await readFile(revisionPath, 'utf8'),
  };
  await mkdir(`${revisionPath}.byos-stage-${process.pid}`);
  await assert.rejects(vendor({ ...settings, engine: 'omit' }));
  assert.equal(await readFile(bundlePath, 'utf8'), before.bundle);
  assert.equal(await readFile(enginePath, 'utf8'), before.engine);
  assert.equal(await readFile(revisionPath, 'utf8'), before.revision);
});

test('CLI runs through a symlinked entry path', async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  const entry = path.join(fx.root, 'vendor-alias.mjs');
  await symlink(fileURLToPath(new URL('./vendor.mjs', import.meta.url)), entry);
  const out = path.join(fx.root, 'cli-output');
  const result = spawnSync(process.execPath, [entry, '--source', fx.source, '--ref', fx.ref,
    '--out', out, '--mode', 'packages', '--packages', 'core', '--engine', 'omit'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /vendored core/);
  assert.match(await readFile(path.join(out, 'REVISION'), 'utf8'), new RegExp(`commit=${fx.ref}`));
});
