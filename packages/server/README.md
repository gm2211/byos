# @byos/server

Server half of the bring-your-own-subscription kit. Design:
https://claude.ai/artifact/1sXmN1AvVjp7jVRefdCShW

`createCodexRelay(options)` returns `{ router, handleUpgrade, close }`: an Express router for the
status and one-time ticket routes, a WebSocket upgrade handler for the tunnels, and a drain hook.
The relay forwards only TLS ciphertext to two fixed hosts (`auth.openai.com`, `chatgpt.com`). The
browser owns the TLS session, so the relay cannot read OpenAI credentials, provider HTTP headers,
or provider request/response bodies. It does receive the application's own session token (from the
configured header or cookie) to authorize tickets, plus connection metadata.

```ts
import { createCodexRelay, type AccountSession } from '@byos/server';

type AppSession = { accountId: string };
// Bind this to the application's existing session store.
declare const mySessions: { get(sessionToken: string): Promise<AppSession | undefined> };
const resolveApplicationSession = async (sessionToken: string): Promise<AccountSession | undefined> => {
  const session = await mySessions.get(sessionToken);
  return session ? { ownerKey: session.accountId } : undefined;
};

const relay = createCodexRelay({
  basePath: '/api/ai/codex-tunnel',
  sessionHeader: 'X-My-Session',
  resolveSession: resolveApplicationSession,
  allowedOrigins: () => new Set(['https://my-site.example']),
  enabled: () => process.env.CODEX_BROWSER_TLS_ENABLED === 'true',
});
app.use(express.json(), relay.router);
relay.handleUpgrade(httpServer);
```

Header mode uses `sessionHeader` to read the site's session token before `resolveSession` maps the
application account identifier to `AccountSession.ownerKey`. The browser's `getSession` callback
must provide the same session token in this header. For same-origin cookie sessions, omit
`sessionHeader` and provide a request reader:

```ts
import { createCodexRelay } from '@byos/server';
import type { IncomingMessage } from 'node:http';

// Bind this to the app's existing signed-cookie parser and session validation.
declare const readAndVerifySessionCookie: (cookieHeader: string | undefined) => string | undefined;
const readApplicationSession = (request: IncomingMessage) =>
  readAndVerifySessionCookie(request.headers.cookie);

const relay = createCodexRelay({
  basePath: '/api/ai/codex-tunnel',
  readSession: readApplicationSession,
  resolveSession: resolveApplicationSession,
  allowedOrigins: () => new Set(['https://my-site.example']),
  enabled: () => true,
});
```

Configure exactly one of `sessionHeader` or `readSession`, and always provide `resolveSession` to
validate the resulting application session handle and return `{ ownerKey }`. A missing or invalid
session returns 401; exceptions from the reader return a generic 503. `basePath` must be a same-origin absolute path
with safe path segments; external URLs, query strings, fragments, repeated slashes, and traversal
segments are rejected during construction.

Limits (per-account and global byte windows, connection caps, frame sizes, lifetimes, public-IP
pinning) are fixed in the package on purpose.
