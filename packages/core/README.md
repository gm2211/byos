# @byos/core

Framework-free browser pieces of the bring-your-own-subscription kit, extracted from Motive so other
sites can reuse them. Design: https://claude.ai/artifact/1sXmN1AvVjp7jVRefdCShW

- `createCredentialVault({ prefix })`: provider tokens and refresh grants in this tab only
  (`session`) or remembered on this browser (`browser`).
- `createEffortStore({ prefix, recommend })`: per provider+model reasoning effort choice, validated
  against what the provider says the model supports.
- `createModelCatalogCache({ prefix })` and `pickerModels`: the provider's last live model list,
  and the rule that a stale list never drops the user's own selection.
- xAI (Grok subscription) OAuth, pure and browser-safe: the public Grok CLI client's constants
  (`XAI_OAUTH_CLIENT_ID`, `XAI_DEVICE_CODE_URL`, `XAI_TOKEN_URL`, `XAI_OAUTH_SCOPE`, refresh window and
  device-flow timing), the exact form requests (`xaiTokenRequestFields`, `xaiFormBody`, `xaiTokenUrl`,
  `XAI_FORM_HEADERS`) and strict parsers (`parseXaiTokenResponse`, `parseXaiDeviceStart`,
  `classifyXaiPollError`, `classifyXaiRefreshFailure`). `conformance/xai-oauth.json` holds synthetic
  vectors that other implementations (Swift, Rust, Python) can check themselves against. Live xAI
  behavior is unverified; the endpoints are undocumented and can change.
- `ByosProvider` types: the contract each provider adapter implements.
- Credential mode (`CredentialMode`: `subscription-and-api-key`, `subscription`, `api-key`):
  `providersForCredentialMode`, `signInMethodsFor`, `allowsSignInMethod`, `credentialKind`,
  `parseCredentialMode` and the request guard `assertCredentialAllowed` (`CredentialModeError`). Pass
  the same mode to `AiConnectPanel` (`credentialMode`). Vectors: `conformance/credential-mode.json`.
- Busy providers and error messages: `sendRetryingWhenBusy` asks a 429/503/529 again after
  `retry-after` or a 2s then 6s backoff (foreground only), honours Claude's plan-window headers, and
  starts a per-provider cooldown (`BusyCooldowns`) when a rate limit outlasts the retries;
  `retryingLostConnection` asks again on a dropped connection; `providerErrorMessage` turns any failure
  into one sentence a person can act on. `decideBusy` is the same rule without I/O. Vectors:
  `conformance/provider-busy.json`.
- `swift/`: the `ByosCore` Swift package for iOS and macOS, with the same credential-mode API
  (`CredentialMode`, `SignInMethod`, `ProviderDescriptor`, `require(_:)`) and the same busy rules
(`sendRetryingWhenBusy`, `BusyCooldowns`, `ProviderErrors.message`, `decideBusy`), the Grok
  and Claude subscription sign-ins (`XAISignIn`, `XAIOAuth`, `ClaudeSignIn`, `ClaudeOAuth`) and token stores (`KeychainTokenStore`,
  `MemoryTokenStore`), tested against the same
  vectors (`swift test --package-path packages/core/swift`).

## Token rule

A provider token may cross the site's backend once, only to finish sign-in, and the user is told so.
After that it lives only in the browser and every model call goes browser to provider. Nothing in
this package sends a stored token anywhere; keep it that way.

Every site passes its own non-empty `prefix` (up to 128 characters), so two sites on one origin
never read each other's tokens. Replacing a credential clears any old refresh grant; store a matching
new grant explicitly with `storeRefresh`.
