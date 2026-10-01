# Customize BYOS without forking it

Keep one small binding layer in each application. Change provider behavior in this kit, then sync the reviewed commit into consumers. Do not edit generated bundles or vendored package source.

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

Import `@byos/react/styles.css` once, then scope CSS tokens to your application container. `DeviceCodeSignIn` and `AiPill` accept `className`; `ModelEffortPicker` exposes `classNames.root` and the field, note, and retry classes. Detailed parts and accessible labels have explicit customization props. [React API](../packages/react/README.md) lists every token and localization seam.

```css
.my-app {
  --byos-font: var(--app-font);
  --byos-text: var(--app-text);
  --byos-surface: var(--app-panel);
  --byos-accent: var(--app-accent);
  --byos-on-accent: var(--app-on-accent);
}
```

On mobile, `AiPill` portals its sheet. If the variables are scoped to `.my-app`, use a portal target under that themed ancestor and outside clipped content. A callback state ref supplies the target after mount; this avoids passing `null` to the pill on its first render. The package's mobile positioning selector targets a direct child of `body`, so this scoped target also needs the positioning rule below.

```css
.my-app-ai-portal { display: contents; }
@media (max-width: 720px) {
  .my-app-ai-portal .byos-pill-popover {
    position: fixed; z-index: 181; top: auto; right: 0; bottom: 0; left: 0; width: auto;
    padding-bottom: calc(16px + env(safe-area-inset-bottom));
    border-radius: var(--byos-radius-lg, 14px) var(--byos-radius-lg, 14px) 0 0;
  }
}
```

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
3. Run each consumer's `scripts/sync-byos.sh <SHA>`.
4. Build/test the affected consumer bindings and inspect affected UI states.
5. Commit generated files and revision record together. Release each application under its own procedure.

`consumers.json` is the integration inventory. Add new consumers there with selected packages, output mode, engine choice, and revision path. Successful local builds prove integration; each application still needs its own authenticated/runtime acceptance before claiming a newly enabled provider works.
