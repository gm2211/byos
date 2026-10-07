# @byos/chatgpt-local

A **Node-only**, independently authored implementation of OpenAI's documented Sign in with ChatGPT plan flow. It signs a user into an app-specific registration and makes direct HTTPS model-list and streaming Responses requests. It does not require Codex, read CLI credentials, reuse the Codex client ID, or change the existing BYOS browser adapters.

This package targets personal local applications. Account eligibility and commercial/hosted service access remain governed by OpenAI. It contains no OpenAI DevKit implementation or UI code. Synthetic tests establish implementation boundaries, not live account eligibility or provider acceptance.

## Local application example

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createChatGptClient, ChatGptError } from '@byos/chatgpt-local';

const execute = promisify(execFile);
const client = createChatGptClient({
  appName: 'My Local App',
  namespace: 'my-local-app',
  // This URL has only public OAuth parameters, never id_token_hint or provider tokens.
  openBrowser: async url => { await execute('/usr/bin/open', [url]); },
});

const accounts = await client.accounts();
// Show accounts with their stable IDs and distinct labels. Let the user choose one.
if (accounts.length) await client.selectAccount(accounts[0].id);
const status = await client.status();
// An explicit Continue with ChatGPT / Enable plan action starts authorization.
if (!status.connected || !status.planEnabled) {
  await client.signIn({ accountId: status.account?.id, enablePlan: true });
}
const models = await client.listModels();
// Show models in this order and use the user's chosen model, not a hardcoded model ID.
const selectedModel = await chooseModel(models);
try {
  const draft = await client.generate({
    model: selectedModel,
    instructions: 'Return a draft for the user to review.',
    input: 'Suggest three names for a community gardening newsletter.',
    onProgress: progress => renderActivity(progress.phase, progress.outputChars),
  });
  // Validate the completed result and let the user review before saving or acting on it.
  renderDraft(draft.text);
} catch (error) {
  if (error instanceof ChatGptError) showError(error.code, error.message);
  else showError('unavailable', 'The operation could not be completed.');
}

// Explicit sign-out stops local requests and tries remote refresh-session revocation.
const { revoked } = await client.disconnect();
if (!revoked) showError('unavailable', 'Signed out locally. Remote revocation was not confirmed; disconnect the app in ChatGPT settings.');
```

`chooseModel`, `renderDraft`, `renderActivity` and `showError` are application-owned functions. The opener example is macOS-specific; other platforms must inject both an appropriate browser opener and a secure credential store. Do not expose this runtime on a remotely hosted server. Browser-facing consumer routes need their own loopback binding, exact Host/Origin checks, CSRF protection, request bounds and cancellation.

## Contract

`createChatGptClient({ appName, namespace, openBrowser, storageDirectory?, credentialStore?, fetch?, now? })` returns:

- `status()` → `{ connected, planEnabled, account?: { id, label, connected } }`. Connected means a saved session exists; it does not establish current allowance or model entitlement.
- `accounts()` → safe registration summaries, including disconnected registrations retained for reauthorization.
- `selectAccount(id)` → selected account status. This does not initiate OAuth or create a client registration.
- `signIn({ accountId?, enablePlan?, signal? })` → validated selected status. Omit `accountId` to add an account/workspace; pass the saved ID to reconnect. `enablePlan: true` sends `prompt=consent` for the user's explicit plan-access action. Identity-only consent remains connected with `planEnabled: false`.
- `disconnect()` → `{ revoked }`; clears selected tokens even when remote revocation cannot be confirmed, while retaining client/account/host mapping. Other saved account sessions remain intact.
- `listModels(signal?)` → `{ id, name }[]`, containing only `visibility: 'list'` rows in provider order.
- `generate({ model, input, instructions?, signal?, onProgress? })` → `{ text }` only after a completed response. Partial, refused, failed and truncated outputs never become accepted drafts. No automatic replay or paid API-key fallback.

Exports include `ChatGptClient`, `ChatGptClientOptions`, `ChatGptStatus`, `ChatGptAccount`, `ChatGptModel`, `GenerationProgress`, `CredentialStore`, `ChatGptError` and `ChatGptErrorCode`. Error messages are fixed safe strings; raw provider error bodies and fetch exceptions never cross the public API.

## Generation activity

`onProgress?: (progress: GenerationProgress) => void` receives only `{ phase, outputChars, outputTokens? }`. Phases reflect observed events: `starting` from response creation/in-progress, `generating` from reasoning activity, and `receiving` from assistant output text. Phases and character counts never regress. `outputChars` counts observed output text in UTF-16 code units; snapshots and completed items do not add text already counted from deltas. Commentary is excluded. A changed final snapshot can be shorter than the observed count. `outputTokens` is reserved for observed usage and is currently omitted; characters are never converted into guessed tokens or percent complete.

The callback receives no prompt, text chunks, reasoning, summaries, response objects or provider error bodies. Raw and decoded credential filtering precedes callbacks. Callback exceptions are ignored. No further callbacks occur after cancellation or terminal completion; progress is activity, never proof of a successful response. The generate promise must still resolve before accepting output. If upstream supplies only a terminal snapshot, activity cannot be reported earlier. Consumer bindings own display wording and completed domain-item counts.

## Credential and process boundary

macOS defaults to native `@napi-rs/keyring` Keychain storage. One atomic secret record holds host identity, registration/account bindings, active account and each token set. There is no plaintext-file fallback, environment-token import, browser token return method, or subprocess credential argument. Injected `CredentialStore` is trusted runtime code and must atomically replace the complete record. It exists for other protected stores and synthetic tests, never for a browser storage adapter.

`storageDirectory` contains **only nonsecret process-lock files**. By default it is an owner-only directory beneath the OS temporary directory; credentials still live solely in Keychain. All processes sharing a namespace must use the same lock directory and store. Existing lock directories must be owned by the user with mode `0700`. Refreshes and store mutations serialize across processes. Dead PID locks can be reclaimed; a live PID is never displaced. If an interrupted lock has no valid owner metadata, operations report `busy`; after confirming no app processes remain, remove that nonsecret stale lock directory.

Per-call cancellation does not abandon a refresh grant after rotation starts. The replacement is saved first, then the canceled caller stops. Sign-out waits for rotation before deleting credentials; lifecycle revisions reject late results and prevent pending sign-ins from reviving disconnected sessions. Calls bind to the account selected when they start.

Authorization uses an ephemeral `127.0.0.1` listener with fixed `/auth/callback`, random state/nonce and PKCE S256. ID tokens are signature/issuer/audience/expiry/nonce validated using `jose` against fixed-issuer JWKS. Returning identities and callback client IDs must match the saved registration. Issued IDs are retained after failed code exchange so a retry can reuse the registration. Optional ID-token hints are deliberately omitted from browser opener URLs.

Inference is text-only and tool-free. It uses `/v1/models` and `/v1/responses`, `store:false`, `stream:true`, and array input. It rejects redirects, bounds JSON/SSE sizes and uses a ten-minute inference deadline. It exposes no general provider proxy or arbitrary URL parameter.

## Verify

```sh
npm ci
npm run test -w @byos/chatgpt-local
npm run check
```

Tests use synthetic signed JWTs, fake protected stores and mocked upstream requests, plus real ephemeral loopback callbacks. Environments must permit loopback listeners. Coverage includes identity/callback validation, account separation, refresh concurrency/cancellation, sign-out, redacted storage failure, request restrictions, completed-response acceptance, fragmented stream activity, observed-count deduplication, observer failures and abort suppression. Live OAuth, native Keychain availability on the deployment machine, actual model access and usage attribution need separate user-involved acceptance.

Protocol references: [registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [session lifecycle](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).
