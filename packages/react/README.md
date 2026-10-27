# @byos/react

React UI for the bring-your-own-subscription kit. Design:
https://claude.ai/artifact/1sXmN1AvVjp7jVRefdCShW

- `DeviceCodeSignIn`: one-time-code subscription sign-in (idle, preparing, code, completing, error,
  connected, unavailable), with a remember-on-this-browser toggle and privacy disclosure. Opt into
  compact Sign in, Privacy, and Help tabs for short setup dialogs.
- `ModelEffortPicker`: model and effort from the provider's own list, using the shared searchable
  combobox by default; `renderSelect` preserves an application-owned control when needed.
- `AiPill`: status pill plus quick-settings popover (bottom sheet on phones).
- `AiQuickSettingsPanel`: reusable provider heading, settings action, connection notice, and settings body for `AiPill` or standalone use.
- `AiConnectPanel`: the complete connect surface: provider picker, then Account / Model / Preferences for the picked service, with every sign-in method the provider declares inline in Account.
- `AiAccountSettings`: compact provider row and keyboard-accessible Model, Account, and optional Tools tabs. It mounts one pane at a time and places expired-account recovery in Account.
- `AiProviderPicker`: short, application-owned provider choice list; selection does not connect or authenticate a provider.
- `SignInWithChatGPT`: localized identity-only website sign-in presentation with approved black/white OpenAI button formats and availability/status slots. The host supplies the start route and its disclosure.
- `CommandPaletteProvider`, `useCommands`, `usePalette`, `CommandPaletteButton`: the ⌘K palette from `@byos/commands` as React. Features register commands while mounted; the provider owns the dialog, shortcut, focus return, and Ask flow. See the [commands README](../commands/README.md).
- `DialogCloseButton`: accessible 44px close control for host-owned dialogs; the caller handles placement and dismissal.
- `useProviderModels`, `useEffortChoice`: headless hooks over `@byos/core`.

## Theming

Import `@byos/react/styles.css`, then point the tokens at your design system:

```css
.checkout-ai {
  --byos-font: var(--my-sans);
  --byos-font-mono: var(--my-mono);
  --byos-text: var(--my-text);
  --byos-muted: var(--my-muted);
  --byos-faint: var(--my-subtle);
  --byos-surface: var(--my-panel);
  --byos-surface-soft: var(--my-panel-soft);
  --byos-surface-raised: var(--my-panel-raised);
  --byos-surface-input: var(--my-input);
  --byos-line: var(--my-border);
  --byos-line-strong: var(--my-border-strong);
  --byos-accent: var(--my-brand);
  --byos-accent-strong: var(--my-brand-hover);
  --byos-on-accent: white;
  --byos-success: var(--my-success);
  --byos-warning: var(--my-warning);
  --byos-warning-soft: var(--my-warning-soft);
  --byos-danger: var(--my-danger);
  --byos-radius: 8px;
  --byos-radius-lg: 14px;
  --byos-shadow: var(--my-popover-shadow);
}
```

Set variables on an ancestor to theme each component, or on one wrapper to theme that section.
On mobile, `AiPill` portals its sheet to `document.body`; set tokens there or pass
`portalContainer` pointing to a themed overlay root outside clipped containers.
Unspecified variables use the neutral defaults. The full token list is font, font-mono, text, muted,
faint, surface, surface-soft, surface-raised, surface-input, surface-overlay, surface-backdrop,
line, line-strong, accent, accent-strong, on-accent, success, warning, warning-soft, danger,
secondary-fill, secondary-border, secondary-hover, pill-fill, pill-border, pill-text, radius,
radius-lg, and shadow
(each uses the `--byos-` prefix).

Use `className` on `DeviceCodeSignIn` and `AiPill`; `ModelEffortPicker` also supports the `root`,
`field`, `note`, and `retry` class names. `AiPill` supports button, prefix, label, popover, and
backdrop class names. These can scope app-specific CSS while preserving the package defaults.

`DeviceCodeSignIn`, `ModelEffortPicker`, `AiQuickSettingsPanel`, `AiAccountSettings`, and `AiProviderPicker` localize UI copy through their `strings` props. `DeviceCodeSignIn` accepts an optional `headingId` for dialog focus management and `compact` for a tabbed presentation. In compact mode, Remember and full privacy details appear on Privacy; code, approval, progress, and cancel stay on Sign in; Help carries sign-in guidance. The short disclosure appears before initial sign-in and is omitted while waiting. ArrowLeft/ArrowRight, Home, and End move between tabs. The default presentation remains unchanged.
`AiPill` uses the explicit label props listed below. For example:

```tsx
<ModelEffortPicker
  {...pickerProps}
  strings={{
    model: 'MODELO',
    modelAriaLabel: 'Seleccionar modelo',
    effort: 'RAZONAMIENTO',
    effortAriaLabel: 'Seleccionar nivel de razonamiento',
  }}
/>

<DeviceCodeSignIn
  {...signInProps}
  providerName="Acme AI"
  strings={{ connectTitle: 'Connect Acme', connectButton: 'Continue with Acme' }}
/>
```

`AiPill` exposes `setupLabel`, `prefix`, and `popoverLabel`, plus `setupAriaLabel` and `ariaLabel`
for localized accessible names. The default searchable picker accepts `portalContainer` when its
menu needs to stay inside a themed overlay root; use `renderSelect` when an application owns the
control itself. Edit `src/styles.src.css` and run `npm run css` only when changing
the package's default CSS; the generated `src/styles.css` is the file consumers import.

`AiQuickSettingsPanel` accepts `connection` as `connected`, `expired`, `disconnected`, or `tools-only`.
It owns the provider header, settings action, state copy, and content spacing; pass an optional
`reconnectAction` for expired connections. `defaultAiQuickSettingsStrings` provides the English
defaults. It does not perform authentication or select providers.

`AiAccountSettings` keeps the selected provider visible and exposes a 44px **Change AI service**
action. Model is the initial tab. Set `signedIn={false}` when no account or API key is connected:
Account then moves first and opens by default, and Model returns to first place once `signedIn`
is true (the active tab follows that default until the user picks one). Account and Tools appear only when their content is supplied;
ArrowLeft/ArrowRight, Home, and End move between tabs. Only the active tab panel is mounted.
When `expired` is true, Model shows a short link to Account and `recoveryAction` appears inside
Account. Provider changes, account controls, and tool actions remain application callbacks/content.
`AiProviderPicker` renders a short list of provider actions with optional badges and selected state;
`onSelect` reports an id and never starts authentication.

```tsx
<AiAccountSettings
  providerName="Example AI"
  expired={connectionExpired}
  signedIn={hasAccountOrKey}
  onChangeProvider={openProviderPicker}
  modelSettings={<ModelEffortPicker {...pickerProps} />}
  accountSettings={<AccountControls />}
  toolsSettings={<ToolControls />}
  recoveryAction={<button onClick={reconnect}>Reconnect</button>}
/>

<AiProviderPicker
  providers={[{ id: 'example', name: 'Example AI', badge: 'Plan' }]}
  selectedId={providerId}
  onSelect={setProviderId}
/>
```

Applications with no frontend build can vendor this package in bundle mode (`scripts/VENDING.md`): the
bundle carries React, exports `createElement`, `Fragment`, and `createRoot`, and ships `byos.css`.

React 18 and 19 are supported, including nullable DOM refs in menus and popovers. React is a peer dependency. When consuming this package through a `file:` link, dedupe React in
your bundler (Vite: `resolve.dedupe: ['react', 'react-dom']`).


`SignInWithChatGPT` renders a 44px native link to the host's website OIDC start route, or a disabled button when `status="unavailable"`. `variant="black" | "white"` selects an approved monochrome sign-in button and bundled official OpenAI vector mark. `onStart` runs synchronously for a normal primary click before the browser follows `href`; pending, success, and unavailable states disable the action. Its inline vector path is taken directly from the official white and black marks in [OpenAI’s website sign-in button assets](https://developers.openai.com/assets/siwc/sign-in-buttons/). Localize `heading`, `description`, button, and state labels through `strings`; provide a product-specific `disclosure` that separates ChatGPT identity from plan usage. The component does not start OAuth itself and does not imply that identity grants ChatGPT subscription usage.

`DeviceCodeSignIn` accepts `signInBrand="chatgpt"` when a provider's device-code flow should use ChatGPT's official monochrome mark and black button styling. This changes presentation only: the existing localized Connect/Try again labels, `onStart` callback, and device-code approval flow remain in effect. It does not represent website identity sign-in or connect the account through OpenID.

```tsx
<SignInWithChatGPT
  href="/auth/chatgpt/start"
  status={identitySignInEnabled ? 'idle' : 'unavailable'}
  message={identitySignInEnabled ? undefined : 'ChatGPT sign-in is not enabled for this app.'}
  disclosure={<p>ChatGPT identity signs in to this app. It does not connect an AI plan.</p>}
/>
```

Set `AiAccountSettings.keepPanelsMounted` for host-owned sign-in or download workflows that must survive tab changes. Inactive panels use HTML `hidden`, with distinct panel IDs and matching `aria-controls`; default behavior still mounts only the active pane.


## AiConnectPanel

`AiConnectPanel` is the native "connect an AI service" surface. Mount it as-is; do not hand-compose a
picker, method screens, and code screens around the lower-level pieces.

- **Picker view** (no `selectedId`, or after **Change AI service**): `heading` (default "Connect AI"),
  `intro`, and an `AiProviderPicker` in two columns (one column when the panel is under 380px wide). When a
  service was already selected a **Back to <name>** button returns to it. Picking calls `onSelect(id)`.
- **Service view**: `AiAccountSettings` with `keepPanelsMounted`, `signedIn` from the service, `expired`,
  the third tab labeled **Preferences** (your `preferences` node; omitted means no tab) and
  `recoveryAction`. Signed out opens on Account; signed in opens on Model.
- **Account, signed out**: the service's optional `notice`, then each method in `provider.signIn`, in
  that order, separated by an "or" divider. Methods come only from `provider.signIn`; a declared kind with
  no controller on the service is not rendered. `device-code` renders a compact `DeviceCodeSignIn`
  (`deviceCode`), `pkce` a primary button with caption, busy state and error (`pkce`), and `api-key` /
  `paste-token` a labelled password field with the method's `hint`, the `api-key` `setup` steps as ordered
  external links, a Connect button (disabled when empty or busy), an error, and a caption. Enter submits.
- **Account, signed in**: "Connected to <name>", the **Stay signed in on this device** switch (when
  `remember` is given) and **Sign out of <name>** (when `onSignOut` is given).

```tsx
<AiConnectPanel
  services={[{
    provider: grokProvider,            // { id, displayName, signIn } from your ByosProvider
    signedIn: grok.connected,
    deviceCode: { status, device, error, onStart, onCancel },
    apiKey: { value: draft, onChange: setDraft, onSubmit: saveKey, error: keyError,
              caption: 'Your key stays in this browser. Requests go straight to xAI.' },
    remember: { checked: remember, onChange: setRemember },
    onSignOut: signOut,
    modelSettings: <ModelEffortPicker {...pickerProps} />,
  }]}
  selectedId={providerId}
  onSelect={setProviderId}
  intro="Use your own AI account."
  preferences={<RetrievalSettings />}
/>
```

Token rule: the panel never sees or sends a token itself. The host's controllers run each flow
browser-direct (or through the handshake the provider discloses; see `docs/customization.md`); the panel
renders their state and reports intent through callbacks. All user-visible English text is in
`defaultAiConnectPanelStrings` and overridable through `strings`. Controls are at least 44px, keyboard
operable, and the layout holds at 320px width.
