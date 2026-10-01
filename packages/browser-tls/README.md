# @byos/browser-tls

Browser half of the Codex subscription transport in the bring-your-own-subscription kit. Design:
https://claude.ai/artifact/1sXmN1AvVjp7jVRefdCShW

`createCodexTlsFetch(options)` returns a `fetch()` limited to OpenAI's Codex sign-in, refresh,
account-catalog and Responses routes. It runs TLS 1.3 inside the page (rustls compiled to WASM,
certificate-checked against webpki roots) and sends only ciphertext through the site's relay
(`@byos/server` `createCodexRelay`). The site never sees tokens, headers or bodies.

The Rust source lives in `rust/`; `scripts/build-engine.sh [OUTPUT_DIR]` builds the pinned engine
from this repository. `engine/build-manifest.json` binds the reviewed binary to source hashes.
A site bundles that reviewed artifact and passes a loader:

```ts
const codexFetch = createCodexTlsFetch({
  loadEngine: () => loadMyBundledBrowserTls(),
  getSession: () => mySession(),              // { session, expiresAt } or null
  relayBasePath: '/api/ai/codex-tunnel',      // same as the relay's basePath
  sessionHeader: 'X-My-Session',              // same as the relay's sessionHeader
  clientLabel: 'My Site browser TLS',
});
```

Sites whose session is a same-origin cookie omit `getSession` and `sessionHeader`: the ticket
request then sends cookies and the relay reads the session from them. Configure the relay with
`readSession(request)` to read and validate that cookie. Header mode requires both `getSession` and
`sessionHeader`; cookie mode omits both. The relay path must be a same-origin absolute path such as
`/api/ai/codex-tunnel`. External URLs, query strings, fragments, repeated slashes, and traversal
segments are rejected before a request or TLS engine load.

The transport's `messages.relayUnavailable` option controls the safe user-facing text for relay
HTTP 503 responses. The default avoids app-specific wording; a site can provide its own recovery
instructions.

`engine/` holds the reviewed WASM build (originally imported from Motive,
hashes in `engine/build-manifest.json` and verified against `rust/`). Load it with:

```ts
loadEngine: async () => { const mod = await import('@byos/browser-tls/engine/motive_browser_tls.js'); await mod.default(); return mod; }
```
