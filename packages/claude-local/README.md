# @byos/claude-local

A **Node-only** Claude Pro/Max subscription client. The user signs in with their Claude account (OAuth 2.0 authorization code + PKCE), the tokens live in the macOS Keychain, and model-list and streaming Messages requests go straight to `api.anthropic.com` over verified HTTPS. No Claude CLI, API key, tunnel or relay is involved. It mirrors `@byos/chatgpt-local`.

Claude subscription sign-in is supported. It works the way the Claude CLI's own login does: the public Claude Code OAuth client (`9d1c250a-e61b-44d9-88ed-5944d1962f5e`), scopes `user:profile user:inference`, `https://claude.com/cai/oauth/authorize` and `https://platform.claude.com/v1/oauth/token`. These endpoints come from the Claude Code CLI's embedded strings (2.1.316), are undocumented and can change; re-check with `strings $(readlink -f $(which claude)) | grep oauth`; the flow is ported from the Skim app, where it signs in successfully. Synthetic tests here establish the request shapes, not live account acceptance. Eligibility and acceptable use follow Anthropic's current terms for your plan.

## Flows

- **Loopback** (`signIn`): binds `http://localhost:54134/callback` (IPv4, plus `::1` when available), reports the authorization URL through `openBrowser`, and waits for the redirect. Claude's client accepts only that exact redirect, so `127.0.0.1` will not work and a busy port fails with `port-in-use`.
- **Paste code** (`beginPasteSignIn` then `completePasteSignIn`): the redirect is Anthropic's console page, which shows a `CODE#STATE` string. The user pastes it back; a bare code also works.

## Requests

A subscription token is a Bearer token sent with `anthropic-beta: oauth-2025-04-20,claude-code-20250219`, and the request's first system block must be `You are Claude Code, Anthropic's official CLI for Claude.` (`generate` adds it before your own instructions). 5-series models think by default, so `generate` asks for low effort and keeps `max_tokens` at 4096 or more so the answer is not starved. Access tokens refresh on demand; the rotated refresh token is persisted under a process lock. A rejected refresh deletes the stored tokens (`reconnect-required`). When the API answers a request with 401 (a token revoked or rotated before its expiry), `generate` and `listModels` force one refresh and retry once; a refresh answered with 400 or 401 is `reconnect-required`, and a second 401 after a good refresh is too.

```ts
import { createClaudeClient, ClaudeError } from '@byos/claude-local';

const client = createClaudeClient({
  appName: 'My Local App',
  namespace: 'my-local-app', // Keychain item byos.claude.my-local-app
  openBrowser: async url => { await open(url); },
});

try { await client.signIn(); }
catch (e) {
  if (e instanceof ClaudeError && e.code === 'port-in-use') {
    const { url } = client.beginPasteSignIn();
    await open(url);
    await client.completePasteSignIn(await askUserForCode());
  }
}
const models = await client.listModels(); // live from Anthropic
const { text } = await client.generate({ model: models[0].id, input: 'Hi', instructions: 'Be brief.', onText: renderDelta });
await client.disconnect(); // removes the local tokens
```

Account labels come from the token response when Anthropic includes the email, otherwise `Claude subscription`. Tokens never leave the process; callers get account metadata, model ids and generated text. Errors are fixed `ClaudeError` codes without provider text. Do not use this as a credential proxy for a hosted multi-user service.

For a browser app that cannot run Node, see `claude({ subscription })` in `@byos/providers` and `createClaudeTokenRelay` in `@byos/server`: the same OAuth client, with the token grants relayed through the host because Anthropic's token endpoint blocks browser origins.
