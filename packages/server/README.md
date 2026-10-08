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


## Sign in with ChatGPT website identity

`createChatGptWebsiteIdentity(options)` implements the identity-only website OIDC flow for an OpenAI-provisioned public client. OpenAI currently limits website Sign in with ChatGPT to selected commercial partners. The helper remains disabled when no `clientId` and exact registered HTTPS `redirectUri` are supplied; there is no sample client ID or automatic fallback. It does not implement ChatGPT plan usage, model access, or credential storage.

```ts
import { createChatGptWebsiteIdentity, type ChatGptWebsiteTransactionStore } from '@byos/server';

declare const transactions: ChatGptWebsiteTransactionStore; // durable and atomically consumes one transaction per browser binding
const identitySignIn = createChatGptWebsiteIdentity({
  clientId: process.env.OPENAI_WEBSITE_CLIENT_ID, // provisioned by OpenAI
  redirectUri: 'https://app.example/auth/chatgpt/callback', // exact registered URL
  transactions,
});

if (identitySignIn.enabled) {
  const { authorizationUrl } = await identitySignIn.begin(browserSessionBinding);
  // Redirect the browser to authorizationUrl. Keep the binding in a Secure, HttpOnly, SameSite=Lax cookie.
}
// In the callback, pass the cookie-bound browserSessionBinding and original callback URL.
const externalIdentity = await identitySignIn.complete(browserSessionBinding, callbackUrl);
// Map `{issuer, clientId, subject}` to the host account, then issue only your own first-party session.
// Do not store or return OAuth tokens; do not auto-link by email alone.
```

The transaction store persists `{ state, nonce, codeVerifier, expiresAt }` server-side, expires it, and atomically deletes it on callback. Runtime failures use `ChatGptWebsiteIdentityError` with the fixed codes `not_configured`, `invalid_request`, or `sign_in_failed`; provider/network details are never included. Bind it to a server-generated browser session, not an email or caller-supplied account ID. The helper requests only `openid profile email`, validates the OpenAI discovery document against fixed production endpoints, uses public-client token auth (`none`), bounds responses, and verifies signature, issuer, audience, expiration, `iat`, subject and nonce with `jose`. It returns only verified identity claims. It never returns, saves, or logs an access token, refresh token, or raw ID token.

Keep this identity session separate from ChatGPT plan connection. The website identity flow does not authorize inference or subscription usage.
