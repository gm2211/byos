# Vendoring BYOS into a consumer

`vendor.mjs` copies a pinned BYOS commit into a consumer repository. It reads a local Git clone and
does not fetch, clone, or invoke a package runner. Pin `--ref` to the full commit SHA. The utility
exports that commit with `git archive`, so dirty and ignored files in the source working tree never
enter the vendored output.

## Copy TypeScript packages

This keeps packages editable and usable by TypeScript-aware consumer builds. Request only the entry
packages your application needs; the utility copies their internal `@byos/*` dependency closure and
rewrites local `file:` links to the configured output names.

```sh
node scripts/vendor.mjs \
  --source ../byos \
  --ref 0123456789abcdef0123456789abcdef01234567 \
  --mode packages \
  --packages react,codex \
  --name-prefix vendor-byos- \
  --out web/vendor \
  --engine include
```

The example copies `core`, `providers`, `browser-tls`, `codex`, and `react` as needed. The browser
TLS engine is copied only when `--engine include` is selected, and its files must match the checked
build manifest. Existing output package directories absent from the new selection are removed only
when their names match a package in the source and the configured prefix. Other consumer files are
preserved.

## Build one static ESM file

Static sites can bundle selected package entry points into one browser ESM file. Add a pinned `esbuild`
version to the consumer's own dependencies and install it before running the utility; vendoring never
downloads build tools.

```sh
node scripts/vendor.mjs \
  --source ../byos \
  --ref 0123456789abcdef0123456789abcdef01234567 \
  --mode bundle \
  --packages providers,codex,browser-tls \
  --out src/static/vendor/byos \
  --engine include
```

Selecting `react` in bundle mode is for consumers with no frontend build. The bundle then carries one
production copy of React and react-dom from this clone's locked tooling install, is minified, and also
exports `createElement`, `Fragment`, and `createRoot` so the page can mount the components without JSX.
The utility writes the package stylesheet beside the bundle as `byos.css` (named after `--bundle-name`)
and removes it again if a later sync drops `react`.

The utility writes `byos.js`, optionally `byos.css` and `engine/`, and `REVISION` under the output directory. Use
`--bundle-name` to change the generated file name. Both modes accept `--revision <path>` to store the
revision record elsewhere. The record contains the source commit, selected dependency closure, mode,
directory prefix or bundle name, and engine choice.

## Failure behavior

The utility resolves and validates the source SHA, package manifests, dependency closure, optional
engine hashes, and generated output before replacing consumer output. It stages work beside the output
and rolls back replaced targets if installation fails. It never recursively deletes the consumer's
output directory. Keep vendored output paths dedicated to generated files and commit the generated
revision record with those files.
