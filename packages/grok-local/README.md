# @byos/grok-local

A **Node-only** Grok (xAI SuperGrok) subscription client. The user signs in with the OAuth device-code flow (RFC 8628), the tokens live in the macOS Keychain, and refresh goes straight to `auth.x.ai` over verified HTTPS. No relay, tunnel or host server is involved. It mirrors `@byos/claude-local`. Inference stays in `grok()` from `@byos/providers`: pass the client's `accessToken()` as the key, or wrap calls in `client.run`.

xAI has no public OAuth client for third-party apps, so this uses the public Grok CLI client (`b1a00492-073a-47ea-816f-4c329264a828`, device endpoint `https://auth.x.ai/oauth2/device/code`, token endpoint `https://auth.x.ai/oauth2/token`). Those values live in `@byos/core` (`xai-oauth.ts`) with synthetic conformance vectors; they are undocumented and can change. **Live xAI behavior is unverified**: tests here are synthetic and establish request shapes, not account acceptance. Some SuperGrok tiers answer 403 from the API even when signed in; keep an API-key path as the fallback.

```ts
import { createGrokClient, GrokError } from '@byos/grok-local';
import { grok } from '@byos/providers';

const client = createGrokClient({ appName: 'My Local App', namespace: 'my-local-app' }); // Keychain item byos.grok.my-local-app

await client.signIn({ onCode: ({ verificationUrl, userCode }) => show(verificationUrl, userCode) });
const models = await grok().listModels(await client.accessToken());
await client.run(signal, async accessToken => callGrokWith(accessToken)); // on a 401: refresh once, retry once
await client.disconnect();
```

- `status()` returns `{ connected, account?: { label } }`. The label is the `email` claim of the id token (display only, unverified) or `Grok subscription`.
- `signIn({ onCode, signal })` hands the verification URL and user code to `onCode` and polls until approved (default interval 5s, `slow_down` adds 5s, at most 15 minutes). A second concurrent call fails with `busy`. Failures are `declined`, `expired`, `auth-failed`, `unavailable`, `canceled`.
- `accessToken(signal?, { rejected? })` refreshes when the token expires within 5 minutes, under a process lock, so concurrent callers and processes spend one grant. Pass `rejected` (the token the API just refused) to force a refresh unless another process already rotated it. A refresh answered 400 or 401 deletes the stored tokens and fails with `reconnect-required`; any other failure keeps using a still-valid token. A rotated refresh token is saved even if the caller cancels.
- `importTokens({ access, refresh?, expiresAt, label? })` adopts tokens an app already holds, for a one-time move from an older Keychain item.
- Errors are `GrokError` with a fixed `code` and message, never provider text. Tokens never leave the process. Do not use this as a credential proxy for a hosted multi-user service.
- Storage: Keychain service `byos.grok.<namespace>`, account `tokens-v1` (macOS only; inject `credentialStore` elsewhere). Lock files hold only a process ID.

For a browser app, see `grok({ subscription })` in `@byos/providers`.
