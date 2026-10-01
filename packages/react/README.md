# @byos/react

React UI for the bring-your-own-subscription kit. Design:
https://claude.ai/artifact/1sXmN1AvVjp7jVRefdCShW

- `DeviceCodeSignIn`: one-time-code subscription sign-in (idle, preparing, code, completing, error,
  connected, unavailable), with a remember-on-this-browser toggle and privacy disclosure.
- `ModelEffortPicker`: model and effort from the provider's own list; `renderSelect` swaps in your
  own select.
- `AiPill`: status pill plus quick-settings popover (bottom sheet on phones).
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
faint, surface, surface-soft, surface-raised, surface-input, line, line-strong, accent,
accent-strong, on-accent, success, warning, warning-soft, danger, radius, radius-lg, and shadow
(each uses the `--byos-` prefix).

Use `className` on `DeviceCodeSignIn` and `AiPill`; `ModelEffortPicker` also supports the `root`,
`field`, `note`, and `retry` class names. `AiPill` supports button, prefix, label, popover, and
backdrop class names. These can scope app-specific CSS while preserving the package defaults.

`DeviceCodeSignIn` and `ModelEffortPicker` localize UI copy through their `strings` props.
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
for localized accessible names. Replace the picker control with `renderSelect` when your design
system needs a searchable select. Edit `src/styles.src.css` and run `npm run css` only when changing
the package's default CSS; the generated `src/styles.css` is the file consumers import.

React is a peer dependency. When consuming this package through a `file:` link, dedupe React in
your bundler (Vite: `resolve.dedupe: ['react', 'react-dom']`).
