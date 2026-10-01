#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const TOOL = 'byos vendor';
const DEFAULT_PREFIX = 'byos-';
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
const ENGINE_FILES = [
  'motive_browser_tls.js',
  'motive_browser_tls.d.ts',
  'motive_browser_tls_bg.wasm',
  'motive_browser_tls_bg.wasm.d.ts',
  'build-manifest.json',
];

function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

function usage() {
  return `Usage:\n  node scripts/vendor.mjs --source <local-git-clone> --ref <full-commit-sha> --out <directory> [options]\n\nOptions:\n  --mode packages|bundle       Copy TypeScript packages or emit one static ESM bundle (default: packages)\n  --packages name,name         Requested package directories (default: all packages)\n  --name-prefix prefix         Output directory prefix in packages mode (default: byos-)\n  --revision path              Revision record path (default: <out>/REVISION)\n  --engine include|omit        Include reviewed browser TLS engine files (default: omit)\n  --bundle-name filename       Bundle filename (default: byos.js)\n  --help                       Show this help`;
}

function parseArgs(argv) {
  const options = {
    mode: 'packages',
    packages: undefined,
    namePrefix: DEFAULT_PREFIX,
    engine: 'omit',
    bundleName: 'byos.js',
  };
  const values = new Map([
    ['--source', 'source'], ['--ref', 'ref'], ['--out', 'out'], ['--mode', 'mode'],
    ['--packages', 'packages'], ['--name-prefix', 'namePrefix'], ['--revision', 'revision'],
    ['--engine', 'engine'], ['--bundle-name', 'bundleName'],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    const key = values.get(arg);
    if (!key) fail(`unknown option ${arg}`);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) fail(`missing value for ${arg}`);
    options[key] = value;
    i += 1;
  }
  for (const required of ['source', 'ref', 'out']) {
    if (!options[required]) fail(`missing required --${required}`);
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(options.ref)) {
    fail('--ref must be a full immutable commit SHA');
  }
  if (!['packages', 'bundle'].includes(options.mode)) fail('--mode must be packages or bundle');
  if (!['include', 'omit'].includes(options.engine)) fail('--engine must be include or omit');
  if (options.packages !== undefined) {
    options.packages = options.packages.split(',').map((name) => name.trim()).filter(Boolean);
    if (options.packages.length === 0 || new Set(options.packages).size !== options.packages.length) {
      fail('--packages must contain unique, non-empty package directory names');
    }
  }
  if (!options.namePrefix || options.namePrefix.includes('/') || options.namePrefix.includes('\\')) {
    fail('--name-prefix must be a non-empty filename prefix');
  }
  if (path.basename(options.bundleName) !== options.bundleName || !options.bundleName.endsWith('.js')) {
    fail('--bundle-name must be a .js filename');
  }
  return options;
}

function git(source, args) {
  const result = spawnSync('git', ['-C', source, ...args], { encoding: 'utf8' });
  if (result.error) fail(`cannot run git: ${result.error.message}`);
  if (result.status !== 0) fail(`git ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout.trim();
}

async function readJson(file, label) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    fail(`${label}: ${error.message}`);
  }
}

async function listPackages(source) {
  const root = path.join(source, 'packages');
  let names;
  try {
    names = await readdir(root, { withFileTypes: true });
  } catch {
    fail(`source has no packages/ directory: ${source}`);
  }
  const result = new Map();
  for (const entry of names.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(root, entry.name);
    let manifest;
    try {
      manifest = await readJson(path.join(dir, 'package.json'), `${entry.name}/package.json`);
    } catch (error) {
      if (String(error.message).includes('ENOENT')) continue;
      throw error;
    }
    if (typeof manifest.name === 'string') result.set(entry.name, { id: entry.name, dir, manifest });
  }
  if (result.size === 0) fail('source contains no package manifests under packages/');
  return result;
}

function dependencyNames(manifest) {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ].filter((name) => name.startsWith('@byos/')));
}

function selectClosure(all, requested) {
  const byName = new Map([...all.values()].map((pkg) => [pkg.manifest.name, pkg]));
  const selected = new Set();
  const visit = (id) => {
    const pkg = all.get(id);
    if (!pkg) fail(`unknown package directory: ${id}`);
    if (selected.has(id)) return;
    selected.add(id);
    for (const name of dependencyNames(pkg.manifest)) {
      const dependency = byName.get(name);
      if (!dependency) fail(`${pkg.manifest.name} depends on ${name}, but source has no matching package`);
      visit(dependency.id);
    }
  };
  for (const id of requested) visit(id);
  return { selected: [...selected].sort(), byName };
}

async function resolvePinnedSource(source, ref) {
  const sourcePath = await realpath(path.resolve(source));
  const sha = git(sourcePath, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (sha.toLowerCase() !== ref.toLowerCase()) fail(`--ref resolved to ${sha}, not the requested full commit SHA`);
  return { sourcePath, commit: sha };
}

async function exportPinnedCommit(sourcePath, commit) {
  const archive = spawnSync('git', ['-C', sourcePath, 'archive', '--format=tar', commit], {
    maxBuffer: 512 * 1024 * 1024,
  });
  if (archive.error) fail(`cannot export pinned commit: ${archive.error.message}`);
  if (archive.status !== 0) fail(`git archive failed: ${String(archive.stderr ?? '').toString().trim()}`);
  const root = await mkdtemp(path.join(os.tmpdir(), 'byos-vendor-source-'));
  const tree = path.join(root, 'tree');
  await mkdir(tree, { recursive: true });
  const extracted = spawnSync('tar', ['-xf', '-', '-C', tree], { input: archive.stdout, encoding: 'utf8' });
  if (extracted.error || extracted.status !== 0) {
    await rm(root, { recursive: true, force: true });
    fail(`could not unpack pinned source tree${extracted.error ? `: ${extracted.error.message}` : ''}`);
  }
  return { root, tree };
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function canonicalizePath(candidate) {
  let probe = path.resolve(candidate);
  const suffix = [];
  while (true) {
    try {
      return path.join(await realpath(probe), ...suffix);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      suffix.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

async function previousBundleOwnsEngine(revisionPath) {
  try {
    const text = await readFile(revisionPath, 'utf8');
    const fields = Object.fromEntries(text.split(/\r?\n/).filter(Boolean).map((line) => {
      const separator = line.indexOf('=');
      return separator < 0 ? [line, ''] : [line.slice(0, separator), line.slice(separator + 1)];
    }));
    return fields.mode === 'bundle' && fields.engine === 'include';
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') return false;
    throw error;
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function validateEngine(engineDir) {
  const manifest = await readJson(path.join(engineDir, 'build-manifest.json'), 'browser-tls engine manifest');
  if (!manifest.files || typeof manifest.files !== 'object') fail('browser-tls engine manifest has no files map');
  for (const filename of ENGINE_FILES.slice(0, -1)) {
    const expected = Object.entries(manifest.files).find(([key]) => path.basename(key) === filename)?.[1];
    if (!/^[0-9a-f]{64}$/i.test(expected ?? '')) fail(`engine manifest has no SHA-256 for ${filename}`);
    let data;
    try {
      data = await readFile(path.join(engineDir, filename));
    } catch {
      fail(`engine artifact missing: ${filename}`);
    }
    if (sha256(data) !== expected.toLowerCase()) fail(`engine artifact hash mismatch: ${filename}`);
  }
}

async function copyPackage(pkg, stageDir, prefix, all, selected, includeEngine) {
  await cp(pkg.dir, stageDir, {
    recursive: true,
    dereference: false,
    filter: async (entry) => {
      const relative = path.relative(pkg.dir, entry);
      if (!relative) return true;
      const segments = relative.split(path.sep);
      if (segments.some((segment) => SKIP_DIRS.has(segment))) return false;
      if (!includeEngine && segments[0] === 'engine') return false;
      return true;
    },
  });
  const manifestPath = path.join(stageDir, 'package.json');
  const manifest = await readJson(manifestPath, `${pkg.id}/package.json`);
  const byName = new Map([...all.values()].map((item) => [item.manifest.name, item]));
  for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
    for (const [name, dependency] of Object.entries(manifest[field] ?? {})) {
      const internal = byName.get(name);
      if (internal) {
        if (!selected.has(internal.id)) fail(`internal dependency closure missing ${name}`);
        manifest[field][name] = `file:../${prefix}${internal.id}`;
      }
    }
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const lockPath = path.join(stageDir, 'package-lock.json');
  try {
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    const rewritePath = (value) => {
      const filePrefix = value.startsWith('file:../') ? 'file:' : '';
      const relative = filePrefix ? value.slice(filePrefix.length) : value;
      if (!relative.startsWith('../')) return value;
      const old = relative.slice(3).split('/')[0];
      return all.has(old) ? `${filePrefix}../${prefix}${old}${relative.slice(`../${old}`.length)}` : value;
    };
    const rewrite = (value) => {
      if (Array.isArray(value)) return value.map(rewrite);
      if (!value || typeof value !== 'object') return typeof value === 'string' ? rewritePath(value) : value;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [rewritePath(key), rewrite(item)]));
    };
    await writeFile(lockPath, `${JSON.stringify(rewrite(lock), null, 2)}\n`);
  } catch (error) {
    if (error.code !== 'ENOENT') fail(`${pkg.id}/package-lock.json: ${error.message}`);
  }
}

async function bundlePackages(stageDir, sourceRoot, selected, all, bundleName) {
  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch {
    fail('bundle mode needs the pinned BYOS esbuild dependency; run npm ci in the BYOS tooling clone first');
  }
  const entries = selected.map((id) => all.get(id));
  const source = entries.map((pkg) => {
    const index = path.relative(sourceRoot, path.join(pkg.dir, 'src', 'index.ts')).split(path.sep).join('/');
    return `export * from ${JSON.stringify(`./${index}`)};`;
  }).join('\n');
  const alias = Object.fromEntries([...all.values()].map((pkg) => [pkg.manifest.name, path.join(pkg.dir, 'src', 'index.ts')]));
  await esbuild.build({
    absWorkingDir: sourceRoot,
    stdin: { contents: source, resolveDir: sourceRoot, sourcefile: 'byos-entry.ts', loader: 'ts' },
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
    alias,
    outfile: path.join(stageDir, bundleName),
    logLevel: 'silent',
  });
}

function revisionText({ commit, mode, selected, prefix, engine, bundleName }) {
  return [
    `commit=${commit}`,
    'sourcePath=packages',
    `mode=${mode}`,
    `packages=${selected.join(',')}`,
    ...(mode === 'packages' ? [`namePrefix=${prefix}`] : [`bundle=${bundleName}`]),
    `engine=${engine}`,
    '',
  ].join('\n');
}

async function stagedInstall({ stageDir, outDir, revisionPath, revision, mode, all, selected, prefix, bundleName, removeStaleEngine }) {
  const parent = path.dirname(outDir);
  await mkdir(parent, { recursive: true });
  const backup = path.join(parent, `.byos-backup-${process.pid}-${Date.now()}`);
  await mkdir(backup, { recursive: true });
  const changes = [];
  const move = async (from, to, label) => {
    let existed = false;
    try { await lstat(to); existed = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const saved = path.join(backup, `${changes.length}-${label}`);
    if (existed) await rename(to, saved);
    changes.push({ to, saved, existed });
    await rename(from, to);
  };
  try {
    await mkdir(outDir, { recursive: true });
    if (mode === 'packages') {
      const knownTargets = [...all.keys()].map((id) => `${prefix}${id}`);
      const selectedTargets = new Set(selected.map((id) => `${prefix}${id}`));
      for (const target of knownTargets) {
        if (!selectedTargets.has(target)) {
          const stale = path.join(outDir, target);
          try {
            await lstat(stale);
            const saved = path.join(backup, `${changes.length}-stale-${target}`);
            await rename(stale, saved);
            changes.push({ to: stale, saved, existed: true });
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
      for (const id of selected) await move(path.join(stageDir, `${prefix}${id}`), path.join(outDir, `${prefix}${id}`), `${prefix}${id}`);
    } else {
      await move(path.join(stageDir, bundleName), path.join(outDir, bundleName), bundleName);
      if (revision.engine === 'include') await move(path.join(stageDir, 'engine'), path.join(outDir, 'engine'), 'engine');
      else if (removeStaleEngine) {
        const stale = path.join(outDir, 'engine');
        try {
          await lstat(stale);
          const saved = path.join(backup, `${changes.length}-stale-engine`);
          await rename(stale, saved);
          changes.push({ to: stale, saved, existed: true });
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    const revisionStage = `${revisionPath}.byos-stage-${process.pid}`;
    await mkdir(path.dirname(revisionPath), { recursive: true });
    await writeFile(revisionStage, revisionText({ ...revision, selected, prefix, bundleName }));
    await move(revisionStage, revisionPath, 'revision');
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    for (const change of [...changes].reverse()) {
      await rm(change.to, { recursive: true, force: true });
      if (change.existed) await rename(change.saved, change.to);
    }
    await rm(backup, { recursive: true, force: true });
    throw error;
  }
}

export async function vendor(options) {
  const { sourcePath, commit } = await resolvePinnedSource(options.source, options.ref);
  const outDir = path.resolve(options.out);
  const revisionPath = path.resolve(options.revision ?? path.join(outDir, 'REVISION'));
  const canonicalOutDir = await canonicalizePath(outDir);
  const canonicalRevisionPath = await canonicalizePath(revisionPath);
  if (within(sourcePath, canonicalOutDir) || within(canonicalOutDir, sourcePath)) fail('output directory must be outside the source clone');
  if (within(sourcePath, canonicalRevisionPath) || within(canonicalRevisionPath, sourcePath)) fail('revision record path must not overlap the source clone');
  if (canonicalRevisionPath === canonicalOutDir || within(canonicalRevisionPath, canonicalOutDir)) fail('revision record path cannot be the output directory or its parent');
  const exported = await exportPinnedCommit(sourcePath, commit);
  try {
    const pinnedSource = exported.tree;
    const all = await listPackages(pinnedSource);
    const requested = options.packages ?? [...all.keys()];
    const { selected } = selectClosure(all, requested);
    const generatedTargets = options.mode === 'packages'
      ? selected.map((id) => path.join(outDir, `${options.namePrefix}${id}`))
      : [path.join(outDir, options.bundleName), ...(options.engine === 'include' ? [path.join(outDir, 'engine')] : [])];
    const canonicalGeneratedTargets = await Promise.all(generatedTargets.map(canonicalizePath));
    if (canonicalGeneratedTargets.some((target) => within(target, canonicalRevisionPath) || within(canonicalRevisionPath, target))) {
      fail('revision record path cannot overlap a generated package, bundle, or engine directory');
    }
    if (canonicalGeneratedTargets.some((target) => target === canonicalRevisionPath)) fail('revision record path collides with generated output');
    if (options.engine === 'include' && !selected.includes('browser-tls')) fail('--engine include requires browser-tls in the selected package dependency closure');
    if (options.engine === 'include') await validateEngine(path.join(all.get('browser-tls').dir, 'engine'));
    const removeStaleEngine = options.mode === 'bundle' && options.engine === 'omit'
      && await previousBundleOwnsEngine(revisionPath);
    const parent = path.dirname(outDir);
    await mkdir(parent, { recursive: true });
    const stageDir = path.join(parent, `.byos-stage-${process.pid}-${Date.now()}`);
    await mkdir(stageDir, { recursive: true });
    const selectedSet = new Set(selected);
    try {
      if (options.mode === 'packages') {
        for (const id of selected) {
          await copyPackage(all.get(id), path.join(stageDir, `${options.namePrefix}${id}`), options.namePrefix, all, selectedSet, options.engine === 'include' && id === 'browser-tls');
        }
        if (options.engine === 'include') {
          const engineDir = path.join(stageDir, `${options.namePrefix}browser-tls`, 'engine');
          await validateEngine(engineDir);
        }
      } else {
        await bundlePackages(stageDir, pinnedSource, selected, all, options.bundleName);
        if (options.engine === 'include') {
          const engineDir = path.join(all.get('browser-tls').dir, 'engine');
          await cp(engineDir, path.join(stageDir, 'engine'), { recursive: true });
        }
      }
      await stagedInstall({
        stageDir, outDir, revisionPath,
        revision: { commit, mode: options.mode, engine: options.engine },
        mode: options.mode, all, selected, prefix: options.namePrefix, bundleName: options.bundleName, removeStaleEngine,
      });
    } finally {
      await rm(stageDir, { recursive: true, force: true });
    }
    return { commit, selected, outDir, revisionPath };
  } finally {
    await rm(exported.root, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await vendor(options);
  process.stdout.write(`${TOOL}: vendored ${result.selected.join(', ')} at ${result.commit.slice(0, 12)} to ${result.outDir}\n`);
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
