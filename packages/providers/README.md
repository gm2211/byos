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
  always come from the provider, never a hard-coded table.
- `buildXaiResponsesBody` / `parseXaiResponsesPayload`: Grok's `/responses` endpoint, the only place
  its web_search tool exists.

Every call here runs in the browser and talks straight to the provider (all three answer CORS). The
token never goes to the site's own server. `claude()` talks to api.anthropic.com with an API key. Claude subscriptions are paused
(`CLAUDE_SUBSCRIPTIONS_PAUSED_NOTE`): Anthropic's terms do not let third-party apps use Claude.ai
sign-in, so a subscription token is refused before any request. Max and Team plans include monthly
Claude API credits spent by ordinary keys; `CLAUDE_API_KEY_SETUP` (also on the sign-in method's
`setup`) links the claim page and the key page so a site can guide users there. The user still pastes
the key: Anthropic has no third-party OAuth that issues one. Codex uses `@byos/browser-tls`.

`createOpenRouterSignIn({ credentialPersistence: 'session', ... })` keeps the connected
key in the current tab and migrates/removes legacy localStorage keys. The default
`'browser'` preserves cross-tab persistence and disconnect tombstones. Session mode
does not share keys across tabs; credential-free notifications cannot transfer them.
PKCE transactions retain their bounded temporary local fallback for callback recovery.
