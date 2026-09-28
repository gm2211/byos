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

const provider = codex({ fetch, readCredential: () => vault.read('chatgpt'), saveCredential: v => vault.store('chatgpt', v, 'browser') });
for await (const ev of provider.stream(vault.read('chatgpt'), { model, messages })) { ... }
```

The provider refreshes the credential when it is near expiry or on a 401 (once), under a Web Lock
so tabs never rotate the refresh grant twice, and saves the new one through `saveCredential`.
