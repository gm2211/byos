# Customize BYOS without forking it

Keep one small binding layer in each application. Change provider behavior in this kit, then sync the reviewed commit into consumers. Do not edit generated bundles or vendored package source.

## Website Sign in with ChatGPT identity

For an approved website client, use `@byos/server` `createChatGptWebsiteIdentity` and `@byos/react` `SignInWithChatGPT`. This is OpenID identity only: it does not grant ChatGPT plan usage or model access. OpenAI currently limits the website integration to selected commercial partners, so omit the client ID and callback until OpenAI provisions both; the server helper then reports `enabled: false`. Keep this distinct from `@byos/chatgpt-local`, which is Node-only for a user-owned local runtime, and from the browser-owned Codex subscription transport.

Bind the short-lived `{ state, nonce, codeVerifier, expiresAt }` transaction to a random server-generated browser session cookie and implement the transaction store with atomic one-time consumption across instances. The callback uses the exact OpenAI-registered redirect URI. Map verified `{ issuer, clientId, subject }` to a local account under explicit account-linking rules; email equality alone does not prove account ownership. Issue only the host's first-party session. Never store or return OAuth tokens or use this identity token for inference.

The shared React component accepts the host start URL, localized strings, status copy, and a disclosure; it does not own the OAuth flow. Keep copy clear that ChatGPT identity signs into your application while AI plan usage remains a separate capability. See the [server flow and storage contract](../packages/server/README.md#sign-in-with-chatgpt-website-identity) and [React presentation API](../packages/react/README.md#sign-in-with-chatgpt-identity).

## Local ChatGPT plan connections

`@byos/chatgpt-local` provides a separate Node-only client for official ChatGPT plan usage. Consumer bindings supply the app name, unique Keychain namespace, and browser opener. Keep the client in the local application process and adapt safe status/model/result methods to your UI; never pass its token records through the existing browser `ByosProvider` contract.

See the [package README](../packages/chatgpt-local/README.md) and [local example](../examples/chatgpt-local/server.mjs). The example verifies loopback peer, Host, Origin and CSRF before sign-in, account switching or inference. OAuth uses a separate, one-shot loopback callback with its own state/PKCE validation. Do not weaken normal UI routes to admit OAuth redirects.

`generate({ ..., onProgress })` optionally supplies metadata-only generation activity: observed phases and monotone UTF-16 output character counts, with no prompt, chunks, reasoning or summaries. Token counts are not estimated. Map this to application wording in the consumer binding; accept output only after the promise resolves and count domain items only after application validation. Callback exceptions and promise rejections are ignored without awaiting async observers, and cancellation stops callbacks.

Choose a stable namespace per consumer; it separates account registration, host identity, credentials and refresh coordination. Native macOS Keychain is the default. Inject a protected store for other supported local runtimes. A storage failure is not permission to use plaintext persistence. No token import from Codex, no secret-bearing shell arguments, no automatic provider/billing fallback.

Use package-mode full-SHA vendoring with `--packages chatgpt-local --engine omit`. Browser bundle mode rejects Node-only packages. Enable the new path explicitly; this does not change existing browser provider storage or relay bindings.

## Storage and session lifetime

Use a stable, unique prefix for each application sharing an origin. Preserve existing prefixes during updates so saved accounts keep working. Credentials default to session-only storage; remember them only after an explicit user choice.

```ts
import { createCredentialVault, createEffortStore, createModelCatalogCache } from '@byos/core';

const namespace = 'my-app-ai-';
const vault = createCredentialVault({ prefix: `${namespace}credential:` });
const efforts = createEffortStore({ prefix: `${namespace}effort:` });
const models = createModelCatalogCache({ prefix: `${namespace}models:` });

vault.store('openrouter', userProvidedToken, remember ? 'browser' : 'session');
// Replacing a token clears the previous account's refresh grant.
vault.clear('openrouter');
```

Each store accepts injected storage for testing or a host-specific browser adapter. The vault is browser-only; never import user tokens into a server binding or send them with application tool requests.

## Provider choices and model behavior

Choose providers explicitly in the application. The kit exports adapters; it does not choose a product's enabled services. Preserve policy/capability gates independently from whether an account is signed in.

```ts
import { openrouter, grok } from '@byos/providers';

const providers = {
  openrouter: openrouter({ appTitle: 'My App' }),
  grok: grok(),
};
const selectedProvider: keyof typeof providers = 'grok';
const provider = providers[selectedProvider];
// grok() has provider id 'xai'; key the vault by the adapter id, not the local map key.
const credential = vault.read(provider.id);
const catalog = await provider.listModels(credential, signal);
for await (const event of provider.stream(credential, {
  model: selectedModel,
  messages,
  signal,
})) {
  if (event.type === 'text') appendText(event.text);
}
```

Model discovery and inference go directly from the browser to the selected provider. Pass cancellation through both; abandoning an iterator cancels its response reader. Keep tool orchestration and product-specific prompts in the browser application. Sign-in is a separate flow: `grok()` enables its site-assisted device-code handshake by default (`handshakeViaSite: true`), while its model requests remain browser-direct. Do not add a backend inference relay.

## Brand and localize React controls

Import `@byos/react/styles.css` once, then scope CSS tokens to your application container. `DeviceCodeSignIn`, `SignInWithChatGPT`, `AiPill`, `AiQuickSettingsPanel`, and `AiAccountSettings` accept `className`; `ModelEffortPicker` exposes `classNames.root` and the field, note, and retry classes. Detailed parts and accessible labels have explicit customization props. [React API](../packages/react/README.md) lists every token and localization seam.

```css
.my-app {
  --byos-font: var(--app-font);
  --byos-text: var(--app-text);
  --byos-surface: var(--app-panel);
  --byos-accent: var(--app-accent);
  --byos-on-accent: var(--app-on-accent);
}
```

On mobile, `AiPill` portals its sheet. If the variables are scoped to `.my-app`, use a portal target under that themed ancestor and outside clipped content. A callback state ref supplies the target after mount; this avoids passing `null` to the pill on its first render. The package applies sheet positioning whenever its `sheetQuery` matches, including when the sheet is rendered into a custom portal root.

```tsx
import { useState } from 'react';
import { AiPill, type AiPillProps } from '@byos/react';

function BrandedAiPill(props: Pick<AiPillProps, 'connected' | 'label' | 'onSetup' | 'children'>) {
  const [portalRoot, setPortalRoot] = useState<HTMLDivElement | null>(null);
  return <div className="my-app">
    <div className="my-app-clipped-panel">
      <AiPill connected={props.connected} label={props.label} onSetup={props.onSetup}
        portalContainer={portalRoot ?? undefined} prefix="IA" setupLabel="Configurar IA"
        setupAriaLabel="Configurar inteligencia artificial" ariaLabel="Configuración de inteligencia artificial">
        {props.children}
      </AiPill>
    </div>
    <div className="my-app-ai-portal" ref={setPortalRoot}/>
  </div>;
}
```

For a custom UI or a non-React application, use `core` and provider adapters directly. Do not depend on private CSS selectors when a prop or token exists. `DeviceCodeSignIn` accepts localized strings and product-owned privacy details; keep its credential disclosure accurate for the selected transport.

## Codex transport bindings

The client and server must agree on relay route and authentication mode. The route is an absolute same-origin path, never an arbitrary host or URL. The browser retains TLS keys and OpenAI credentials. In header mode, the browser also sends the application's own session token to the ticket route; cookie mode sends the same-origin cookie. The relay needs that application session to authorize its one-use ticket, but never receives a readable OpenAI credential. Customize labels and the application session boundary, not upstream destinations, certificate validation, or safety limits.

Header-based sessions:

```ts
import { createCodexRelay } from '@byos/server';
import { createCodexTlsFetch } from '@byos/browser-tls';

type AppSession = { relaySession: string; expiresAt: number; accountId: string };
declare const appSessionStore: {
  current(): AppSession | null;
  get(relaySession: string): Promise<Pick<AppSession, 'accountId'> | undefined>;
};
const getApplicationSession = () => {
  const session = appSessionStore.current();
  return session ? { session: session.relaySession, expiresAt: session.expiresAt } : null;
};
const resolveApplicationSession = async (relaySession: string) => {
  const session = await appSessionStore.get(relaySession);
  return session ? { ownerKey: session.accountId } : undefined;
};

const codexFetch = createCodexTlsFetch({
  loadEngine,
  relayBasePath: '/api/ai/codex-tunnel',
  getSession: getApplicationSession,
  sessionHeader: 'X-My-App-Session',
  clientLabel: 'My App browser TLS',
});
const relay = createCodexRelay({
  basePath: '/api/ai/codex-tunnel',
  sessionHeader: 'X-My-App-Session',
  resolveSession: resolveApplicationSession,
  allowedOrigins: () => new Set(['https://app.example']),
  enabled: () => applicationCapabilityEnabled,
});
```

Cookie-based sessions omit `getSession` and `sessionHeader` in the browser. The server supplies `readSession` to extract the application's existing signed cookie/session handle and uses the same `resolveApplicationSession` mapping to validate it. Origin checks, account limits, one-use tickets, and revocation checks still apply. The application session is separate from the OpenAI credential; never pass the OpenAI token as the application session.

```ts
import type { IncomingMessage } from 'node:http';

// Use the application's existing signed-cookie parser; return its opaque session handle.
declare const readAndVerifySessionCookie: (cookieHeader: string | undefined) => string | undefined;
const readApplicationSession = (request: IncomingMessage) =>
  readAndVerifySessionCookie(request.headers.cookie);

const relay = createCodexRelay({
  basePath: '/api/ai/codex-tunnel',
  readSession: readApplicationSession,
  resolveSession: resolveApplicationSession,
  allowedOrigins: () => new Set(['https://app.example']),
  enabled: () => applicationCapabilityEnabled,
});
app.use(express.json(), relay.router);
relay.handleUpgrade(httpServer);
// Call relay.close() during shutdown.
```

`@byos/codex` takes the TLS fetch and vault callbacks. Use the application's stable namespace for refresh coordination; preserve the user's selected storage lifetime when saving a rotated token. A caller canceled during shared refresh stops waiting, while the refresh saves any rotated grant for the other callers. Inference is never automatically replayed.

## Update all consumers

1. Change the kit and run `npm run check`.
2. Commit and review the kit PR; retain its full commit SHA.
3. Run each consumer's sync script with the full SHA, using its recorded package/bundle configuration.
4. Build/test the affected consumer bindings and inspect affected UI states.
5. Commit generated files and revision record together. Release each application under its own procedure.

`consumers.json` is the integration inventory. Add new consumers there with selected packages, output mode, engine choice, and revision path. Successful local builds prove integration; each application still needs its own authenticated/runtime acceptance before claiming a newly enabled provider works.
