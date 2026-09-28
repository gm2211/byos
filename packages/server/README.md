# @byos/server

Server half of the bring-your-own-subscription kit. Design:
https://claude.ai/artifact/1sXmN1AvVjp7jVRefdCShW

`createCodexRelay(options)` returns `{ router, handleUpgrade, close }`: an Express router for the
status and one-time ticket routes, a WebSocket upgrade handler for the tunnels, and a drain hook.
The relay forwards only TLS ciphertext to two fixed hosts (`auth.openai.com`, `chatgpt.com`); the
browser owns the TLS session, so the site never sees Codex tokens, headers or bodies.

```ts
const relay = createCodexRelay({
  basePath: '/api/ai/codex-tunnel',
  sessionHeader: 'X-My-Session',
  resolveSession: async token => (await mySessions.get(token)) ? { ownerKey: userId } : undefined,
  allowedOrigins: () => new Set(['https://my-site.example']),
  enabled: () => process.env.CODEX_BROWSER_TLS_ENABLED === 'true',
});
app.use(express.json(), relay.router);
relay.handleUpgrade(httpServer);
```

Limits (per-account and global byte windows, connection caps, frame sizes, lifetimes, public-IP
pinning) are fixed in the package on purpose.
