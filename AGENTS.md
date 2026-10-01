# BYOS repository instructions

- This repository owns reusable BYOS behavior. Consumers must not patch vendored package source or generated bundles; change the kit here, then sync a pinned commit.
- Keep application branding, storage namespaces, session lookup, relay routes, provider selection, and policy gates in consumer bindings. Use existing options, localized strings, headless hooks, and scoped `--byos-*` tokens before adding APIs.
- Preserve default behavior when extending customization. Validate independent namespaces and custom bindings with synthetic credentials; never include real credentials in commands, output, tests, logs, or commits.
- Provider tokens and TLS keys remain browser-owned after the provider-specific disclosed initial sign-in exchange. Codex authentication, refresh, discovery, and inference use only verified browser TLS over the bounded fixed-destination ciphertext relay. Never add a plaintext fallback or backend provider orchestration.
- Readable provider tokens, provider payloads, raw provider errors, and TLS keys must not enter backend tools, diagnostics, persisted checkpoints, or analytics. Model output is browser data, not a safe diagnostic.
- Run `npm ci` and `npm run check` before publishing changes. Root workspace order keeps core before its consumers. Verify both TypeScript-package and static-bundle consumers when sync tooling changes.
- Keep `README.md`, package READMEs, `docs/customization.md`, and `consumers.json` current. Document the concrete capability and limits; do not claim authenticated provider success from synthetic tests.
- Commit scoped changes, push a `codex/` branch (use `codex-` if the remote already has a conflicting `codex` branch), and create a PR. Merge after checks pass. The kit has no production deployment; consumers follow their own release procedures.
