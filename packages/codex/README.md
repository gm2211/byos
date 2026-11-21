# @byos/codex

ChatGPT (Codex) subscriptions for the bring-your-own-subscription kit. Ported from Motive's
`web/src/codex-connect.ts`, `codex-responses.ts` and `codex-model-catalog.ts`, with Motive's
research features (web search, images, tool calls) left out: this is plain chat.

Every request goes through the TLS-in-page fetch from `@byos/browser-tls`, so the site's relay
(`@byos/server` `createCodexRelay`) only ever sees ciphertext.

```ts
const fetch = createCodexTlsFetch({ loadEngine, relayBasePath: '/api/ai/codex-tunnel', clientLabel: 'My Site' });
const start = await startCodexDeviceSignIn(fetch);          // show start.userCode, open start.verificationUri
const poll = await pollCodexDeviceSignIn(fetch, start);     // every start.interval s until !poll.pending
vault.store('chatgpt', poll.credential, 'browser');

const provider = codex({ fetch, readCredential: () => vault.read('chatgpt'), saveCredential: v => vault.store('chatgpt', v, 'browser'), namespace: 'my-site' });
for await (const ev of provider.stream(vault.read('chatgpt'), { model, messages })) { ... }
```

The provider refreshes the credential when it is near expiry or on a 401 (once), under a Web Lock
so tabs never rotate the refresh grant twice, and saves the new one through `saveCredential`.
Set `namespace` to a stable site-specific id when multiple apps share an origin; it scopes the Web
Lock name and avoids unrelated apps contending during refresh. Omit it for the shared default lock.

## Default: `chatgpt()`, code sign-in first with the official fallback

`chatgpt({ code, official })` combines the two adapters (Giulio, 2026-11-21). Its sign-in methods
are `device-code` then `pkce`; it is available when either path is, and routes each saved
credential to the adapter that made it (`chatgptCredentialPath`). Use
`chatgptCodeSignInAvailable({ code })` to decide whether to show the code step.

## Official ChatGPT plan sign-in, no relay (`chatgptPlan`)

`plan.ts` is OpenAI's official [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source)
plan flow for a page: the flow `@byos/chatgpt-local` and ByosCore Swift use. It does not use the
TLS fetch, the relay or the Codex client ID. OpenAI redirects only to
`http://127.0.0.1:1455/auth/callback`, so the person pastes that address back:

```ts
const registration = createChatGptPlanRegistration({ prefix: 'my-site-chatgpt:' });
const { url, attempt } = await beginChatGptPlanSignIn({ appName: 'My Site', hostId: registration.hostId(), clientId: registration.clientId() });
const done = await completeChatGptPlanSignIn(attempt, pastedAddress);   // straight to auth.openai.com
registration.saveClientId(done.clientId);
vault.store('chatgpt', done.credential, 'browser');

const provider = chatgptPlan({ appName: 'My Site', namespace: 'my-site', readCredential, saveCredential, onRegistrationReset: () => registration.forgetClientId() });
```

Models come from `https://api.openai.com/v1/models` and chat from `/v1/responses` with
`store: false`, `stream: true` and no sampling fields; `webSearch` adds OpenAI's `web_search` tool. Errors
carry fixed text. Tests use synthetic tokens; live acceptance by OpenAI is not shown by them.
