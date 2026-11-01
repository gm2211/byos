# @byos/providers

Provider adapters for the bring-your-own-subscription kit. Design:
https://claude.ai/artifact/1sXmN1AvVjp7jVRefdCShW

- `openrouter()`, `grok()`, `groq()`, `huggingface({ clientId? })`: `ByosProvider` objects (sign-in
  methods, live model list, streaming chat). Pass `{ appTitle }` so OpenRouter attributes usage to
  your site. `huggingface()` offers PKCE "Sign in with Hugging Face" only when `clientId` is given
  (see `createHuggingFaceSignIn` in huggingface-sign-in.ts), otherwise just the pasted-token path.
- `endpointFor(provider, credential, { appTitle })`: the browser-direct base URL, headers and web
  search mechanism for each provider.
- `listOpenRouterModels`, `listModelsForEndpoint`, `readOpenRouterKeyInfo`: model discovery. Lists
  always come from the provider, never a hard-coded table. `listModelsForEndpoint` (Grok, Groq,
  Hugging Face) keeps the order the provider returns and drops image, video, audio and embedding
  models such as `grok-imagine-image`, Imagen, Nano Banana, Veo and Lyria (`isChatModel`).
- `claudeAcceptsTemperature(model)`: false for Claude 4.7 and later and every 5-series model, which answer a `temperature` field with a 400; true for Claude 3.x and 4.0-4.6 (an unrecognised id is false, so the API default applies). `ChatRequest` has no temperature field; use this when your own request code sets one.
- `ProviderRequestError(message, status)`: thrown wherever a provider HTTP status is known, including
  `listModelsForEndpoint`, `listOpenRouterModels` and `readOpenRouterKeyInfo` (their message text is
  unchanged; `OpenRouterAuthenticationError` is one, with status 401 or 403).
- `classifyProviderError(error)`: returns `{ kind, message }` for the UI. `kind` is `auth` (401/403, reconnect),
  `quota` (402/429), `aborted` (`AbortError` or `TimeoutError`) or `unavailable` (anything else). It reads the
  numeric `status` off `ProviderRequestError` or any error that carries one (such as `ClaudeAuthError`).
  `message` is fixed text chosen by `kind`; provider text, which can echo request data, is never returned.
- `buildXaiResponsesBody` / `parseXaiResponsesPayload`: Grok's `/responses` endpoint, the only place
  its web_search tool exists.

Browser adapters run in the browser and talk straight to the provider. The
token never goes to the site's own server. `claude()` talks to api.anthropic.com with an API key, or with a
Claude Pro/Max subscription token (`sk-ant-oat…`): subscription tokens go out as a Bearer header with the OAuth
beta flags and the Claude Code system block they require. api.anthropic.com accepts those calls from a browser page;
only Anthropic's OAuth token endpoint refuses browsers. In Node, sign-in is
[`@byos/claude-local`](../claude-local/README.md) (Keychain, loopback OAuth plus a paste-code fallback), which issues the
token. In a browser, pass `claude({ subscription: { tokenFetch, readCredential, saveCredential, namespace? } })`:
`signIn` then offers `{ kind: 'pkce', handshakeViaSite: true, completion: 'paste-code' }` before the API-key
method, and the stored credential (`claude-subscription:` + base64url JSON) is refreshed near expiry under a Web Lock
and once more after a 401.

- `beginClaudeSignIn()` returns `{ url, attempt }` (claude.ai authorize URL with S256 PKCE; the attempt expires after
  20 minutes). `completeClaudeSignIn(tokenFetch, attempt, pasted, signal?)` parses `CODE#STATE` (or a bare code),
  exchanges it, and returns the encoded credential. Errors are `ClaudeAuthError` / `ClaudeReconnectRequiredError`
  (`status` 401) with fixed text, never provider text.
- `claudeTokenRelayFetch({ path })` is the `tokenFetch` for a host that mounts `createClaudeTokenRelay`
  (`@byos/server`): it carries only Anthropic's token URL and POSTs the same body to the host's same-origin `path`.
  The exchange and each refresh therefore pass through the host's relay, which neither stores nor logs them.
- A live sign-in against Anthropic's paste-code redirect is unverified.

### Grok subscription refresh

`grok({ subscription: { tokenFetch, readCredential, saveCredential, namespace? } })` keeps a Grok
(SuperGrok) sign-in alive past its first hour. The stored value is the encoded `grok-subscription:`
credential (base64url JSON: access token, refresh token, optional id token, expiry, label); the
adapter refreshes it within 5 minutes of expiry (single-flight, cross-tab via a Web Lock) and once more
after a 401 on `listModels` or before the first stream event. It never retries a 403, because some
SuperGrok tiers answer 403 while signed in. Only the access token goes to `api.x.ai`; the encoded
record never does. Without `subscription`, a record is used until it expires, then `GrokReconnectRequiredError`.
API keys are passed through and never refreshed. `signIn` is unchanged.

- `tokenFetch` is always called with `XAI_TOKEN_URL` and a form body with exactly the two
  `XAI_FORM_HEADERS`. In a browser pass `createCodexTlsFetch(...)` from `@byos/browser-tls` (the codex
  relay must enable the ciphertext `xai-auth` destination); in Node or native pass `globalThis.fetch`.
  A Grok refresh grant never goes through a plaintext host relay.
- `grokCredentialFromDeviceTokens({ accessToken, refreshToken?, idToken?, expiresIn? })` turns the
  device-code broker's result into the encoded credential to store. Storing only the access token
  signs the user out after about an hour.
- `grokVaultBinding(vault, slot)` gives `{ readCredential, saveCredential }` over a `createCredentialVault`
  that keeps the access token and refresh grant in separate slots; a legacy pair reads as a record that
  refreshes on first use (`grokCredentialFromLegacy`).
- `createGrokSubscription(options).accessToken(token, { force?, signal? })`, `refreshGrokCredential`,
  `encodeGrokCredential` / `decodeGrokCredential`, `isGrokSubscriptionRecord`, `grokNeedsRefresh`.
  Errors are `GrokReconnectRequiredError` (status 401; a 400/401 from auth.x.ai) and `GrokAuthError`
  (status 502; any other failure, with fixed text). A transient failure keeps using a still-valid access token.
- Live xAI behavior is unverified, and whether xAI rotates refresh tokens is unconfirmed, hence the single flight.

`claude({ subscriptionsPaused: true })` is an opt-in gate for hosts that must refuse subscription tokens
(`CLAUDE_SUBSCRIPTIONS_PAUSED_NOTE`). Max and Team plans also include monthly Claude API credits spent by
ordinary keys; `CLAUDE_API_KEY_SETUP` (also on the sign-in method's `setup`) links the claim page and the key page.
Codex uses `@byos/browser-tls`.

`createOpenRouterSignIn({ credentialPersistence: 'session', ... })` keeps the connected
key in the current tab and migrates/removes legacy localStorage keys. The default
`'browser'` preserves cross-tab persistence and disconnect tombstones. Session mode
does not share keys across tabs; credential-free notifications cannot transfer them.
PKCE transactions retain their bounded temporary local fallback for callback recovery.

## On-device providers

`ON_DEVICE_PROVIDERS` describes `local` (embedded llama.cpp), `mlx`, and `foundation-models` (Apple Intelligence). `onDeviceProvidersFor({ kind, supportedProviders })` returns options only when `kind` is `native` and the host explicitly lists a supported binding. `browser` and `server` never expose these options, even if given supported IDs.

`createOnDeviceProvider(id, { runtime, bridge })` returns a credential-free adapter with `signIn: []`, `availability()`, `listModels(signal?)`, and `stream(request)`. It shares `CatalogModel`, `ChatRequest`, and `ChatEvent` types with browser adapters, but takes no token argument. The host bridge implements those three methods. Requests are gated by runtime, supported binding, and current bridge readiness before dispatch. Cancellation passes through to the bridge; hosts must honor the signal and release their engine resources when the iterator closes. Bridge failures use fixed public errors rather than leaking raw native diagnostics.

Native applications own model downloads, storage, engine/IPC lifecycle, and availability probes. `availability()` reports the latest readiness state synchronously; the host refreshes that state using its asynchronous platform checks. Unavailable reasons are user-facing text: never include credentials, prompts, outputs, or raw diagnostics. A listed binding may still need a model download or Apple Intelligence enabled before inference. No native SDK is bundled and no request falls back to a web service. See [binding example](../../docs/customization.md#on-device-models).
