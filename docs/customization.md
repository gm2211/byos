# Customize BYOS without forking it

Keep one small binding layer in each application. Change provider behavior in this kit, then sync the reviewed commit into consumers. Do not edit generated bundles or vendored package source.

## Website Sign in with ChatGPT identity

For an approved website client, use `@byos/server` `createChatGptWebsiteIdentity` and `@byos/react` `SignInWithChatGPT`. This is OpenID identity only: it does not grant ChatGPT plan usage or model access. OpenAI currently limits the website integration to selected commercial partners, so omit the client ID and callback until OpenAI provisions both; the server helper then reports `enabled: false`. Keep this distinct from `@byos/chatgpt-local`, which is Node-only for a user-owned local runtime, and from the browser-owned Codex subscription transport.

Bind the short-lived `{ state, nonce, codeVerifier, expiresAt }` transaction to a random server-generated browser session cookie and implement the transaction store with atomic one-time consumption across instances. The callback uses the exact OpenAI-registered redirect URI. Map verified `{ issuer, clientId, subject }` to a local account under explicit account-linking rules; email equality alone does not prove account ownership. Issue only the host's first-party session. Never store or return OAuth tokens or use this identity token for inference.

The shared React component accepts the host start URL, localized strings, status copy, and a disclosure; it does not own the OAuth flow. Keep copy clear that ChatGPT identity signs into your application while AI plan usage remains a separate capability. See the [server flow and storage contract](../packages/server/README.md#sign-in-with-chatgpt-website-identity) and [React presentation API](../packages/react/README.md#sign-in-with-chatgpt-identity).

## Local ChatGPT plan connections

`@byos/claude-local` is the Claude Pro/Max equivalent: same Node-only shape (app name, Keychain namespace, browser opener), loopback OAuth on `localhost:54134` with `beginPasteSignIn`/`completePasteSignIn` as the fallback. Vendor it with `--packages claude-local --engine omit`. Pair it with `claude()` from `@byos/providers` for API keys; the client itself lists models and generates. For a browser app with no Node process, see [Claude subscription in a browser app](#claude-subscription-in-a-browser-app).

`@byos/grok-local` is the Grok (xAI SuperGrok) equivalent: Node-only, device-code sign-in (`signIn({ onCode })`), Keychain tokens, refresh straight to `auth.x.ai` under a process lock, `run` retries once on a 401. Vendor it with `--packages grok-local --engine omit`; inference stays in `grok()` from `@byos/providers`. For a browser app, see [Grok subscription refresh](#grok-subscription-refresh). Live xAI behavior is unverified.

`@byos/chatgpt-local` provides a separate Node-only client for official ChatGPT plan usage. Consumer bindings supply the app name, unique Keychain namespace, and browser opener. Keep the client in the local application process and adapt safe status/model/result methods to your UI; never pass its token records through the existing browser `ByosProvider` contract.

See the [package README](../packages/chatgpt-local/README.md) and [local example](../examples/chatgpt-local/server.mjs). The example verifies loopback peer, Host, Origin and CSRF before sign-in, account switching or inference. OAuth uses a separate, one-shot loopback callback with its own state/PKCE validation. Do not weaken normal UI routes to admit OAuth redirects.

`generate({ ..., onProgress })` optionally supplies metadata-only generation activity: observed phases and monotone UTF-16 output character counts, with no prompt, chunks, reasoning or summaries. Token counts are not estimated. Map this to application wording in the consumer binding; accept output only after the promise resolves and count domain items only after application validation. Callback exceptions and promise rejections are ignored without awaiting async observers, and cancellation stops callbacks.

Choose a stable namespace per consumer; it separates account registration, host identity, credentials and refresh coordination. Native macOS Keychain is the default. Inject a protected store for other supported local runtimes. A storage failure is not permission to use plaintext persistence. No token import from Codex, no secret-bearing shell arguments, no automatic provider/billing fallback.

Use package-mode full-SHA vendoring with `--packages chatgpt-local --engine omit`. Browser bundle mode rejects Node-only packages. Enable the new path explicitly; this does not change existing browser provider storage or relay bindings.


**iOS and macOS (Swift).** `ByosCore` has the same plan sign-in natively: a loopback listener on `127.0.0.1` (port 1455, else 54321), the registration kept across sign-outs as OpenAI asks, and refreshes shared between concurrent callers because ChatGPT refresh tokens rotate:

```swift
import ByosCore

let chatgpt = ChatGPTSignIn(appName: "My App",
    store: KeychainTokenStore(service: "com.example.app.chatgpt"),
    registration: KeychainChatGPTRegistrationStore(service: "com.example.app.chatgpt"))
try await chatgpt.signIn { url in presentInAppBrowser(url) } // keep the app in front so the listener stays up
let token = try await chatgpt.accessToken()                  // refreshed with under two minutes left
```

Sign-in checks the callback state, a returning account's client id, the ID token's issuer, audience, nonce and expiry, and that plan usage (`chatgpt.tokens.use.direct`) was granted.
## Claude subscription in a browser app

The OAuth endpoints (authorize `https://claude.com/cai/oauth/authorize`, paste redirect `https://platform.claude.com/oauth/code/callback`, token `https://platform.claude.com/v1/oauth/token`) come from the Claude Code CLI's embedded strings (checked against CLI 2.1.316), are undocumented and can change. Re-check with `strings $(readlink -f $(which claude)) | grep oauth`.

`claude()` is API-key-only until the host passes `subscription`. With it, the provider declares `{ kind: 'pkce', handshakeViaSite: true, completion: 'paste-code' }` before the API-key method, and refreshes the credential (single-flight, cross-tab) near expiry and once after a 401.

```ts
import { beginClaudeSignIn, claude, claudeTokenRelayFetch, completeClaudeSignIn } from '@byos/providers';

const tokenFetch = claudeTokenRelayFetch({ path: '/api/ai/claude/token' }); // same-origin path to the relay
const provider = claude({
  subscription: {
    tokenFetch,
    namespace: 'my-site', // Web Lock name suffix
    readCredential: () => vault.read('claude'),
    saveCredential: value => vault.store('claude', value, vault.persistence('claude')),
  },
});

// Start: open `url` in a new tab and keep `attempt` (20-minute TTL) in host state.
const { url, attempt } = await beginClaudeSignIn();
window.open(url, '_blank', 'noopener');
// Finish with whatever the user pasted; store the result in the vault as the Claude token.
const credential = await completeClaudeSignIn(tokenFetch, attempt, pasted);
vault.store('claude', credential, 'session');
```

Render the paste step with `PasteCodeSignIn` (stateless; the host owns `status`, the `code` draft and callbacks) or hand `AiConnectService.pasteCode` to `AiConnectPanel`. On an error, keep the attempt so the user can paste again; clear the draft on cancel and success. The stored value is the encoded `claude-subscription:` credential; model calls send only its access token.

The host mounts the relay itself, before any global body parser:

```ts
import { createClaudeTokenRelay } from '@byos/server';

const claudeRelay = createClaudeTokenRelay({
  basePath: '/api/ai/claude', // GET /status, POST /token
  allowedOrigins: () => new Set(['https://my-site.example']),
  enabled: () => process.env.CLAUDE_RELAY !== 'false',
  resolveSession: async token => sessions.get(token), // optional; pair with readSession or sessionHeader
  sessionHeader: 'X-My-Session',
});
app.use(claudeRelay.router); // before app.use(express.json())
```

Limits to state in the host's UI and docs: sign-in is paste-code only (no popup or redirect); the host's server sees the code exchange and each refresh, and the tokens in those responses, in transit (it stores and logs nothing); the relay accepts only the Claude Code client's two grant shapes, 4 KiB bodies, same-origin browser calls, 20 requests a minute per account or address and 300 overall; and live acceptance of the paste-code redirect by Anthropic is unverified. `claude({ subscriptionsPaused: true })` still removes the sign-in method and refuses subscription credentials.


**iOS and macOS (Swift).** `ByosCore` has the same paste-back sign-in natively, calling the token endpoint directly with tokens and the attempt in the Keychain:

```swift
import ByosCore

let claude = ClaudeSignIn(
    store: KeychainTokenStore(service: "com.example.app.claude"),
    attempts: KeychainClaudeAttemptStore(service: "com.example.app.claude"))
let attempt = claude.beginOrResume()        // open attempt.authorizeURL; survives suspension and relaunch
try await claude.finish(pasted: text)       // CODE#STATE, a bare code or the callback URL
let token = try await claude.accessToken()  // refreshed with under a minute left
```

A pasted email login code, a code from another attempt, or an empty paste each throw a `ClaudeOAuthError` with its own plain message. The same rules are `readClaudePastedCode` in TypeScript; both run `conformance/claude-oauth.json`.
## Grok subscription refresh

Grok sign-in is a device-code flow whose access token lasts about an hour. To keep it alive, store the encoded credential (not just the access token) and pass `subscription` to `grok()`. The refresh grant goes browser to `auth.x.ai` inside browser TLS, through the ciphertext `xai-auth` destination of the codex relay; it never crosses a plaintext host route.

```ts
import { createCodexTlsFetch } from '@byos/browser-tls';
import { grok, grokCredentialFromDeviceTokens, grokVaultBinding } from '@byos/providers';

// The codex relay must allow the xai-auth destination: createCodexRelay({ destinations: ['auth', 'responses', 'xai-auth'], ... }).
const codexFetch = createCodexTlsFetch({ /* relayBasePath, engine, session binding as for Codex */ });
const provider = grok({
  subscription: {
    tokenFetch: codexFetch,
    namespace: 'my-site', // Web Lock name suffix
    ...grokVaultBinding(vault, 'grok'), // readCredential / saveCredential over a core vault
  },
});

// After the device-code broker returns tokens, store the whole record so the refresh grant is kept.
vault.store('grok', grokCredentialFromDeviceTokens(status.tokens), 'session');
```

Use your own `readCredential`/`saveCredential` instead of `grokVaultBinding` if the vault holds the record as one string. The Node equivalent (Keychain, device-code sign-in, direct `auth.x.ai`) is `@byos/grok-local`. Limits: whether xAI rotates refresh tokens is unconfirmed (refresh is single-flight either way); a 403 is never retried because some SuperGrok tiers answer 403 while signed in; a refresh answered 400 or 401 asks the user to reconnect, any other failure keeps the current access token until it expires. Live xAI behavior is unverified.

**iOS and macOS (Swift).** `ByosCore` has the same flow natively, calling `auth.x.ai` directly with tokens in the Keychain:

```swift
import ByosCore

let grok = XAISignIn(store: KeychainTokenStore(service: "com.example.app.xai"))
let start = try await grok.begin()       // show start.userCode; open start.pageToOpen
try await grok.complete(start)           // polls through pending, slow_down and dropped connections
let token = try await grok.accessToken() // refreshed when under 5 minutes are left; nil when signed out
```

A refresh answered 400 or 401 clears the store and throws `XAIOAuthError.signInExpired`; any other failure keeps the current token while it still works. The parsers (`XAIOAuth.parseTokenResponse`, `parseDeviceStart`, `classifyPollError`, `classifyRefreshFailure`) run the same `conformance/xai-oauth.json` vectors as the TypeScript ones.

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

## Subscriptions, API keys, or both

Each application picks a credential mode, one setting that governs every surface:

| Mode | Offers | Hides |
| --- | --- | --- |
| `subscription-and-api-key` (default) | plan sign-ins and API key fields | nothing |
| `subscription` | plan sign-ins (device code, PKCE, pasted subscription token) | every API key field; key-only providers |
| `api-key` | API key fields | plan sign-ins; sign-in-only providers |

Credential-free providers (on-device models, `signIn: []`) stay in every mode.

**Web.** Filter the provider list, render the panel in that mode, and guard request paths so a key saved under an earlier mode is never sent:

```ts
import { assertCredentialAllowed, providersForCredentialMode, type CredentialMode } from '@byos/core';
import { AiConnectPanel, CredentialModePicker } from '@byos/react';

const mode: CredentialMode = 'subscription';
const offered = providersForCredentialMode(allProviders, mode); // copies, with only allowed sign-in methods
<AiConnectPanel credentialMode={mode} services={services} selectedId={id} onSelect={setId}/>;
assertCredentialAllowed(mode, storedCredential.kind); // throws CredentialModeError ('api-key' in subscription mode)
```

`CredentialModePicker` is an optional radio group for an admin, developer or settings screen that lets someone change the mode; the host stores the choice.

**iOS and macOS (Swift).** `packages/core/swift` is the `ByosCore` Swift package with the same API and raw values:

```swift
import ByosCore

let mode = CredentialMode(parsing: storedValue, fallback: .subscription)
let offered = mode.providers(allProviders)        // any SignInDeclaring type, or ProviderDescriptor
let showKeyField = mode.allows(.apiKey)
try mode.require(.apiKey)                         // CredentialModeError before a stored key is sent
```

Add it as a local SwiftPM package (a vendored copy lands at `<prefix>core/swift`). Both packages test against `packages/core/conformance/credential-mode.json`, so the web and Swift behavior cannot drift apart.

## Busy providers, rate limits and error messages

Send every cloud request through the busy rules, and show `providerErrorMessage` for any other failure. Raw error bodies never reach the UI.

| Answer | What happens |
| --- | --- |
| 429 with `retry-after`, a usage window, or a reason | Asked again after `max(retry-after, 2s)`, then 6s. A wait over 20s, a closed plan window, or a third 429 fails with a plain message and starts a cooldown (the provider's wait, else 60s). |
| 429 with only `"Error"` and no headers | Claude turning the request down: returned as is, no retry, no cooldown. |
| 503 or 529 (overloaded) | Asked again the same way; then "X is overloaded right now". No cooldown. |
| A dropped connection | Asked again on a fresh one after 0.5s, then 2s. |
| Background lane | Never retried, and stops at once during any cooldown, so prefetch work cannot crowd out the reader. |

```ts
import { ProviderBusyError, providerErrorMessage, sendRetryingWhenBusy } from '@byos/core';

const claude = { name: 'Claude', credential: 'subscription', sharedLimitNote: 'Claude.ai and Claude Code count toward the same limit.' } as const;
try {
  const response = await sendRetryingWhenBusy(() => fetch(url, init), { provider: claude, lane: 'foreground' });
  if (!response.ok) throw new Error(providerErrorMessage(claude, response.status, await response.text(), response.headers));
} catch (error) {
  if (error instanceof ProviderBusyError) show(error.message); // "You've reached your Claude plan's usage limit. It resets at 3:00 PM. ..."
}
```

```swift
import ByosCore

let claude = BusyProvider(name: "Claude", credential: .subscription)
let (data, response) = try await sendRetryingWhenBusy(request, provider: claude, lane: .foreground) // throws ProviderBusyError
if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
    throw MyError(ProviderErrors.message(claude, status: http.statusCode, body: data))
}
```

Both packages test against `packages/core/conformance/provider-busy.json`.

## Request shaping and lanes

Build Claude and ChatGPT-plan bodies with the shared rules instead of by hand. Each one is a fix for a failure Skim hit: a `temperature` field 400s on Claude 4.7+ and the 5-series; a 5-series model can spend a small `max_tokens` on thinking and return nothing; a subscription token without the Claude Code block gets a bare 429; ChatGPT plan usage rejects sampling fields and is only finished at `response.completed`.

```ts
import { ChatGPTResponsesStream, requestPacer, shapeChatGPTBody, shapeClaudeBody } from '@byos/core';

const claudeBody = shapeClaudeBody({ model, messages, instructions, subscription: true, maxTokens: 850 });
const chatgptBody = shapeChatGPTBody({ model, instructions, turns });
const stream = new ChatGPTResponsesStream('My App');
for (const line of lines) if (stream.consume(line)) break;
const answer = stream.finish(); // throws ChatGPTResponseError with a sentence to show

// Background work (ratings, digests) waits while the person's own request is in flight.
await requestPacer.run('background', () => sendRetryingWhenBusy(send, { provider, lane: 'background' }));
```

```swift
let body = ClaudeRequest.body(model: model, messages: messages, instructions: instructions, subscription: true, maxTokens: 850)
var stream = ChatGPTResponses.Stream(appName: "My App")
let answer = try await RequestPacer.shared.run(.foreground) { try await send(body) }
```

Both packages test against `packages/core/conformance/request-shaping.json`.

## On-device models

Keep execution location separate from subscription sign-in. Embedded models, MLX and Apple Intelligence need no account or token. Use the native catalog only for a user-owned application runtime with installed engine bindings:

```ts
import { createOnDeviceProvider, onDeviceProvidersFor } from '@byos/providers';

// Inject this from the trusted native host, not from its user-agent string.
const runtime = { kind: 'native' as const, supportedProviders: ['mlx'] as const };
const options = onDeviceProvidersFor(runtime);
const provider = createOnDeviceProvider('mlx', {
  runtime,
  bridge: {
    availability: () => nativeModelService.readiness,
    listModels: signal => nativeModelService.listModels(signal),
    stream: request => nativeModelService.stream(request),
  },
});
const status = provider.availability();
if (status.available) {
  const models = await provider.listModels(signal);
  for await (const event of provider.stream({ model: models[0].id, messages, signal })) {
    if (event.type === 'text') appendText(event.text);
  }
}
```

On an Apple silicon Mac, a local Node app can skip writing the service: `@byos/mlx-local` supplies the `mlx` and `foundation-models` bridges, model downloads and status (see its README).

```ts
import { createMlxLocal } from '@byos/mlx-local';

const local = createMlxLocal({ modelsDir }); // modelsDir is optional; share it between apps to share downloads
await local.status();
const provider = local.provider('mlx');      // same OnDeviceProvider as above
```

Otherwise the `nativeModelService` is supplied by the application. It must execute locally and honor cancellation. Use your llama.cpp binding for `local`, MLX binding for `mlx`, and Foundation Models binding for `foundation-models`. Readiness must reflect actual hardware/OS support, model installation, and feature enablement; a user-agent or provider ID is not evidence of availability. Apple Intelligence bindings should refresh status from `SystemLanguageModel.default.availability`. Keep platform model catalogs and download UX in the host.

For browser or hosted-server apps, pass `{ kind: 'browser', supportedProviders: [] }` or `{ kind: 'server', supportedProviders: [] }`. Both return no on-device options and reject discovery/inference even when a bridge is supplied. A future browser engine needs a separate explicit capability contract; this native adapter does not enable it. Existing browser subscription/API adapters keep their credential and transport boundaries. Do not route native prompts to a hosted service or silently switch provider/billing when unavailable.

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

The client and server must agree on relay route and authentication mode. The route is an absolute same-origin path, never an arbitrary host or URL. The browser retains TLS keys and OpenAI credentials. In header mode, the browser also sends the application's own session token to the ticket route; cookie mode sends the same-origin cookie. The relay needs that application session to authorize its one-use ticket, but never receives a readable OpenAI credential. Customize labels and the application session boundary, not upstream hosts, certificate validation, or safety limits. The only destination knob is `destinations` on `createCodexRelay`: it defaults to `['auth', 'responses']`, and adding `'xai-auth'` (auth.x.ai:443, tunnel `${basePath}/xai-auth`) lets the browser renew a Grok token with `POST https://auth.x.ai/oauth2/token` inside its own TLS. Hosts stay fixed and ciphertext-only; a disabled destination is refused at the ticket (400) and upgrade (403).

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

Codex account discovery and browser TLS headers use `CODEX_CLIENT_VERSION` and
`CODEX_ACCOUNT_CATALOG_URL` from `@byos/core`. Consumers must use that shared URL;
model IDs still come from OpenAI's catalog, without a fixed model allowlist. The
compatibility version is reviewed with stable Codex releases, rather than fetched
from untrusted runtime input. Catalog inclusion is not proof of inference access.
