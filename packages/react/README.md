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
:root {
  --byos-font: var(--my-sans);
  --byos-accent: var(--my-brand);
  --byos-surface: var(--my-panel);
  /* ...see the header of src/styles.src.css for the full list */
}
```

Every token has a neutral default. Components also take `className`/`classNames` and a `strings`
object for all visible text. Edit `src/styles.src.css` and run `npm run css` to regenerate
`src/styles.css`.

React is a peer dependency. When consuming this package through a `file:` link, dedupe React in
your bundler (Vite: `resolve.dedupe: ['react', 'react-dom']`).
