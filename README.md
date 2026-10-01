# BYOS — bring your own subscription

Reusable browser-owned AI connections for applications that let people use their own subscriptions or API keys. The kit owns provider behavior; each application owns its branding, storage namespace, session binding, provider choices, and policy gates.

## Start here

```sh
git clone https://github.com/gm2211/byos.git
cd byos
npm ci
npm run check
```

Node 22.23.2 or newer is required. One locked workspace builds and tests all six packages in dependency order. `npm run check` also verifies the reviewed TLS engine hashes and consumer vendoring tests. GitHub Actions runs the same gate.

| Package | Purpose |
| --- | --- |
| `@byos/core` | Framework-free credential vault, effort store, model cache, provider contract |
| `@byos/providers` | Browser provider adapters, sign-in, model discovery, streaming chat |
| `@byos/react` | Optional components and headless hooks; localized strings and scoped CSS tokens |
| `@byos/browser-tls` | Verified TLS inside the browser for fixed OpenAI routes |
| `@byos/codex` | ChatGPT device sign-in, refresh, models, streaming Responses adapter |
| `@byos/server` | Bounded ciphertext relay and disclosed provider device-code broker |

Run `npm run example` for the synthetic, provider-free React customization playground.
Each package README documents its API. [Customization recipes](docs/customization.md) cover branding, localization, persistence, provider selection, cookie/header sessions, and updates.

## Consume a pinned revision

Packages are not published to npm. npm does not support installing a package subdirectory using a GitHub `#main&path:` dependency. Vendor a reviewed commit using `scripts/vendor.mjs`, or use local `file:` dependencies on a checkout built with `npm run build`.

```sh
# TypeScript/React application. Only the named BYOS directories are replaced.
node scripts/vendor.mjs --source . --ref "$(git rev-parse HEAD)" --mode packages \
  --out /path/to/app/shared --packages core,providers,react,browser-tls,server \
  --name-prefix byos- --revision /path/to/app/shared/BYOS_REVISION --engine omit

# Application with no frontend build: one browser ES module plus reviewed WASM.
node scripts/vendor.mjs --source . --ref "$(git rev-parse HEAD)" --mode bundle \
  --out /path/to/app/static/vendor/byos --packages core,providers,codex,browser-tls \
  --engine include
```

Use a full commit SHA for reproducible updates. The utility exports committed source, includes transitive local dependencies, rewrites package links, and validates staged output before replacing managed files. Bundles use the locked esbuild dependency, without runtime npm downloads. TLS engine files are verified against their manifest before copying. Consumer repositories commit the generated output and revision record so production builds need no private GitHub access.

[consumers.json](consumers.json) records the current bindings: Motive uses TypeScript/React packages and its own reviewed engine build; Tracked uses an ES module and the kit's reviewed engine. Both update through `scripts/sync-byos.sh [commit-or-ref]`. Application changes stay in their wrappers, never in vendored source.

## Credential boundary

Provider credentials live in the browser. For providers whose existing device-code flow uses a disclosed initial exchange, the broker returns the token once and never persists or logs it; later model requests go directly from browser to provider. Manual token import never calls the application's backend.

Codex uses verified TLS inside the browser for authentication, refresh, model discovery, and inference. The site's relay forwards only bounded ciphertext to fixed OpenAI destinations; it receives no provider-readable tokens, headers, payloads, or TLS keys. It can observe destination, handshake metadata, timing, sizes, and application session metadata. There is no plaintext fallback or automatic inference replay.

Hosted browser code remains within the user's trust boundary: it can read browser-held values and can change after review. Synthetic regression tests verify lifecycle and transport boundaries; they do not establish current provider policy, browser CORS support, or authenticated live model acceptance. Applications retain their own capability gates and live verification.

## TLS engine provenance

`packages/browser-tls/rust/` owns the Rust source, copied byte-for-byte from the reviewed Motive implementation. `engine/` retains the existing reviewed binary and original source hashes; `npm run check` verifies both. Motive's compatibility paths point to the vendored kit source, so future fixes have one owner.

Run `npm run test:rust` for native security-invariant tests. Rebuild with `npm run build:engine -- /path/to/output` using Rust 1.94.1, LLVM clang/llvm-ar 23.1.0, wasm32-unknown-unknown, and wasm-bindgen CLI 0.2.128. `BYOS_LLVM_PREFIX`, `BYOS_WASM_BINDGEN`, and `BYOS_TLS_TARGET_DIR` customize local tooling. The script writes a new source/artifact manifest only after building. The legacy `motive_browser_tls` filename and virtual source path remain for binary and consumer compatibility. An imported reviewed binary is not evidence of a fresh reproduction on every machine.
