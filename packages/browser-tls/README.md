# @byos/browser-tls

Browser half of the Codex subscription transport in the bring-your-own-subscription kit. Design:
https://claude.ai/artifact/1sXmN1AvVjp7jVRefdCShW

`createCodexTlsFetch(options)` returns a `fetch()` limited to OpenAI's Codex sign-in, refresh,
account-catalog and Responses routes. It runs TLS 1.3 inside the page (rustls compiled to WASM,
certificate-checked against webpki roots) and sends only ciphertext through the site's relay
(`@byos/server` `createCodexRelay`). The site never sees tokens, headers or bodies.

The WASM engine is built from Motive's `browser-tls/` crate by `scripts/build-browser-tls.sh`, with
hashes pinned in `web/src/generated/browser-tls/build-manifest.json`. A site bundles that reviewed
artifact and passes a loader:

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
request then sends cookies and the relay reads the session from them.

`engine/` holds the reviewed WASM build (copied from Motive's `web/src/generated/browser-tls/`,
hashes in `engine/build-manifest.json`). Load it with:

```ts
loadEngine: async () => { const mod = await import('./engine/motive_browser_tls.js'); await mod.default(); return mod; }
```
