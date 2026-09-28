# byos: bring your own subscription

A kit that lets a website use its visitors' own AI subscriptions or API keys (Grok, OpenRouter,
Claude by API key, ChatGPT via the encrypted relay) without the site ever holding a provider token
after sign-in. Extracted from [Motive](https://github.com/gm2211/motive) (`shared/byos-*`) so other
sites can reuse it. Design: https://claude.ai/artifact/1sXmN1AvVjp7jVRefdCShW

| Package | Path | What it is |
| --- | --- | --- |
| `@byos/core` | `packages/core` | Framework-free browser pieces: credential vault, effort store, model catalog cache, the `ByosProvider` contract |
| `@byos/providers` | `packages/providers` | Provider adapters (OpenRouter, Grok, Groq, Hugging Face, Claude): sign-in methods, live model lists, streaming chat, browser to provider |
| `@byos/react` | `packages/react` | React UI: device-code sign-in, model and effort picker, AI pill; themed with `--byos-*` CSS variables |
| `@byos/server` | `packages/server` | Server half: device-code sign-in broker, ciphertext-only Codex relay |
| `@byos/browser-tls` | `packages/browser-tls` | Browser TLS (rustls in WASM) for Codex over the relay; the reviewed engine build is in `engine/` |
| `@byos/codex` | `packages/codex` | ChatGPT subscriptions: device-code sign-in, token refresh, account model list, streaming chat, as a `ByosProvider` |

Each package's README has its API. The token rule every package keeps: a provider token may cross
the site's backend once, only to finish sign-in, and the user is told so; after that it lives only
in the browser and every model call goes browser to provider.

## Using it

- **npm / bundler sites**: depend on a package by path or git URL, e.g.
  `"@byos/core": "github:gm2211/byos#main&path:packages/core"` or a `file:` link to a checkout.
- **No-build sites**: bundle `core` + `providers` into one ES module with esbuild, as
  [tracked](https://github.com/gm2211/tracked) does in `scripts/sync-byos.sh`, and style the UI yourself.

Pass every site its own storage `prefix` so two sites on one origin never read each other's tokens.

## Develop

```bash
cd packages/core && npm ci && npm test        # same for providers, react, server, browser-tls
```

`@byos/browser-tls` needs the reviewed WASM engine built from Motive's `browser-tls/` crate
(`scripts/build-browser-tls.sh` there). A copy of that build is in `packages/browser-tls/engine/`,
with `build-manifest.json` holding its sha256 hashes; sites serve `motive_browser_tls.js` and
`motive_browser_tls_bg.wasm` side by side and pass a loader.

Source of the initial import: gm2211/motive@c9c2e84 `shared/byos-{core,providers,react,server,browser-tls}`,
with the `file:../byos-core` links renamed to `file:../core`. Motive itself is unchanged.
