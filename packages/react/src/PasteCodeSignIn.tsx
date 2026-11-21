import { useEffect, useId, useRef, useState, type ClipboardEvent, type FormEvent, type ReactNode } from 'react';
import { ByosIcon } from './icons.js';
import { LockNote, SettingsList, SettingsNav, SettingsRow, SettingsToggleRow } from './SettingsList.js';

/**
 * Paste-code subscription sign-in (Claude): the user approves on the provider's own page, which shows
 * a code to copy back here. Presentational and stateless: the host's connect hook owns `status`, the
 * `code` draft and the callbacks, so the pasted code never lives in this component past a render.
 *
 * TOKEN RULE: this component never sees a token. The pasted code is a one-time authorization code
 * that the host exchanges (through its token relay) and discards.
 */
export type PasteCodeStatus = 'idle' | 'awaiting-code' | 'exchanging' | 'error';

export type PasteCodeSignInStrings = {
  planName: string;
  connectTitle: string;
  connectBody: string;
  connectButton: string;
  pasteTitle: string;
  pasteLabel: string;
  pasteHint: string;
  submit: string;
  exchanging: string;
  reopen: string;
  cancel: string;
  unavailable: string;
  unavailableButton: string;
  remember: string;
  privacySummary: string;
  /** The one-click button that reads the clipboard; shown only with `onPasteFromClipboard`. */
  pasteFromClipboard: string;
  /** List layout: the detail beside the provider name while pasting. */
  pasteStep: string;
  /** List layout: accessible name of the icon-only Back button. */
  back: string;
};

export function defaultPasteCodeStrings(providerName: string): PasteCodeSignInStrings {
  return {
    planName: 'Subscription',
    connectTitle: `Sign in with ${providerName}`,
    connectBody: 'Use the subscription you already pay for.',
    connectButton: `Sign in with ${providerName}`,
    pasteTitle: `Paste the code ${providerName} shows you`,
    pasteLabel: `Paste the code ${providerName} shows you`,
    pasteHint: `After you approve, ${providerName} shows a code. Copy all of it and paste it here.`,
    submit: 'Connect',
    exchanging: 'Completing sign-in…',
    reopen: `Open ${providerName} again`,
    cancel: 'Cancel sign-in',
    unavailable: `${providerName} sign-in is unavailable right now.`,
    unavailableButton: 'Sign-in unavailable',
    remember: 'Remember on this browser',
    privacySummary: 'How sign-in and privacy work',
    pasteFromClipboard: 'Paste and connect',
    pasteStep: 'Step 2 of 2',
    back: 'Back',
  };
}

export type PasteCodeSignInProps = {
  providerName: string;
  /** Optional heading id; makes the heading a programmatic focus target. */
  headingId?: string;
  status: PasteCodeStatus;
  /** False when this build or policy cannot use the provider; sign-in is disabled with a notice. */
  available?: boolean;
  error?: string;
  /** The pasted draft. The host owns it so it can clear it on cancel, success and navigation. */
  code: string;
  onCodeChange: (code: string) => void;
  /** Opens the provider's approval page (and starts an attempt). */
  onStart: () => void;
  onSubmit: (code: string) => void;
  onCancel: () => void;
  /**
   * What the user will see and do on the provider's side (numbered steps, a picture). Shown before
   * they leave and again beside the paste box, so nothing on the other page comes as a surprise.
   */
  guide?: ReactNode;
  /** Submit as soon as text is pasted into the box, with no second click. */
  submitOnPaste?: boolean;
  /**
   * Adds a one-click button for hosts that can read the clipboard (`navigator.clipboard.readText`
   * inside this click) and submit what they find.
   */
  onPasteFromClipboard?: () => void;
  remember?: { checked: boolean; onChange: (checked: boolean) => void; error?: string };
  /** One short line, always visible, saying who can see what during sign-in. */
  disclosure?: ReactNode;
  /** Longer privacy explanation behind a disclosure toggle. */
  privacyDetails?: ReactNode;
  /** Whether to show the provider and plan eyebrow. Defaults to true. */
  showProviderIdentity?: boolean;
  strings?: Partial<PasteCodeSignInStrings>;
  className?: string;
  /**
   * 'stacked' (default): heading, body, boxed disclosure, checkbox and an expanding privacy section.
   * 'list': a settings-style screen. A nav row (icon Back, provider, plan), one primary button, a
   * one-line lock note, then rows: a Remember switch, any `alternatives`, and "How sign-in works",
   * which drills into `privacyDetails` instead of expanding.
   */
  layout?: 'stacked' | 'list';
  /** List layout: shows the icon-only Back button in the nav row. */
  onBack?: () => void;
  /** List layout: other ways in, as drill-in rows (e.g. "Use an API key instead"). */
  alternatives?: { label: ReactNode; onSelect: () => void }[];
};

export function PasteCodeSignIn(props: PasteCodeSignInProps) {
  if (props.layout === 'list') return <ListPasteCodeSignIn {...props}/>;
  const s = { ...defaultPasteCodeStrings(props.providerName), ...props.strings };
  const { status } = props;
  const available = props.available ?? true;
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const exchanging = status === 'exchanging';
  const pasting = status === 'awaiting-code' || status === 'error' || exchanging;
  const empty = props.code.trim().length === 0;
  useEffect(() => { if (status === 'awaiting-code') input.current?.focus(); }, [status]);

  function pasted(event: ClipboardEvent<HTMLInputElement>) {
    if (!props.submitOnPaste || exchanging) return;
    const text = event.clipboardData?.getData('text') ?? '';
    if (!text.trim()) return;
    event.preventDefault();
    props.onCodeChange(text);
    props.onSubmit(text);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!empty && !exchanging) props.onSubmit(props.code);
  }

  return <div className={`byos byos-signin${props.className ? ` ${props.className}` : ''}`}>
    <header className="byos-signin-heading">
      {props.showProviderIdentity !== false && <span className="byos-signin-provider">{props.providerName} <span>{s.planName}</span></span>}
      <h3 id={props.headingId} tabIndex={props.headingId ? -1 : undefined}>{pasting ? s.pasteTitle : s.connectTitle}</h3>
      {!pasting && <p>{s.connectBody}</p>}
    </header>

    {!available && <p className="byos-signin-unavailable" role="status">{s.unavailable}</p>}
    {props.disclosure && <p className="byos-signin-disclosure">{props.disclosure}</p>}

    {props.guide && <div className="byos-signin-guide">{props.guide}</div>}

    {pasting ? <form className="byos-signin-paste" onSubmit={submit}>
      <label className="byos-signin-paste-label" htmlFor={`${id}-code`}>{s.pasteLabel}</label>
      <p className="byos-signin-paste-hint" id={`${id}-hint`}>{s.pasteHint}</p>
      <input
        ref={input}
        id={`${id}-code`}
        className="byos-signin-paste-input"
        type="password"
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="off"
        value={props.code}
        disabled={exchanging}
        aria-describedby={[`${id}-hint`, props.error ? `${id}-error` : ''].filter(Boolean).join(' ')}
        aria-invalid={status === 'error' ? true : undefined}
        onChange={event => props.onCodeChange(event.target.value)}
        onPaste={pasted}
      />
      {props.error && <p className="byos-signin-error" id={`${id}-error`} role="alert">{props.error}</p>}
      {props.onPasteFromClipboard && empty && !exchanging
        ? <button className="byos-signin-primary" type="button" onClick={props.onPasteFromClipboard}>{s.pasteFromClipboard}</button>
        : <button className="byos-signin-primary" type="submit" disabled={empty || exchanging} aria-busy={exchanging || undefined}>{exchanging ? s.exchanging : s.submit}</button>}
      <div className="byos-signin-progress">
        {status === 'error' && <button className="byos-signin-secondary" type="button" onClick={props.onStart}>{s.reopen} <ByosIcon name="external"/></button>}
        <button className="byos-signin-cancel" type="button" onClick={props.onCancel}>{s.cancel}</button>
      </div>
    </form> : <>
      {props.error && <p className="byos-signin-error" role="alert">{props.error}</p>}
      <button className="byos-signin-primary" type="button" disabled={!available} onClick={props.onStart}>
        <span>{available ? s.connectButton : s.unavailableButton}</span>
        {available && <ByosIcon name="external"/>}
      </button>
    </>}

    {(props.remember || props.privacyDetails) && <div className="byos-signin-storage">
      {props.remember && <label><input type="checkbox" checked={props.remember.checked} onChange={event => props.remember!.onChange(event.target.checked)}/><span>{s.remember}</span></label>}
      {props.remember?.error && <p className="byos-signin-storage-error" role="alert">{props.remember.error}</p>}
      {props.privacyDetails && <details className="byos-signin-privacy">
        <summary>{s.privacySummary}</summary>
        {props.privacyDetails}
      </details>}
    </div>}
  </div>;
}

function ListPasteCodeSignIn(props: PasteCodeSignInProps) {
  const s = { ...defaultPasteCodeStrings(props.providerName), ...props.strings };
  const { status } = props;
  const available = props.available ?? true;
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const exchanging = status === 'exchanging';
  const pasting = status === 'awaiting-code' || status === 'error' || exchanging;
  const empty = props.code.trim().length === 0;
  useEffect(() => { if (status === 'awaiting-code') input.current?.focus(); }, [status]);
  const cls = `byos byos-signin byos-signin-list${props.className ? ` ${props.className}` : ''}`;

  if (privacyOpen && props.privacyDetails) return <div className={cls}>
    <SettingsNav title={s.privacySummary} onBack={() => setPrivacyOpen(false)} backLabel={s.back} headingId={props.headingId}/>
    <div className="byos-signin-privacy-page">{props.privacyDetails}</div>
  </div>;

  function pasted(event: ClipboardEvent<HTMLInputElement>) {
    if (!props.submitOnPaste || exchanging) return;
    const text = event.clipboardData?.getData('text') ?? '';
    if (!text.trim()) return;
    event.preventDefault();
    props.onCodeChange(text);
    props.onSubmit(text);
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!empty && !exchanging) props.onSubmit(props.code);
  }

  const nav = <SettingsNav title={props.providerName} detail={props.showProviderIdentity === false ? undefined : pasting ? s.pasteStep : s.planName} onBack={props.onBack} backLabel={s.back} headingId={props.headingId}/>;
  if (pasting) return <div className={cls}>
    {nav}
    <form className="byos-signin-paste" onSubmit={submit}>
      <label className="byos-signin-paste-label" htmlFor={`${id}-code`}>{s.pasteLabel}</label>
      <p className="byos-signin-paste-hint" id={`${id}-hint`}>{s.pasteHint}</p>
      <div className="byos-input-row">
        <input
          ref={input}
          id={`${id}-code`}
          className="byos-signin-paste-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          value={props.code}
          disabled={exchanging}
          aria-describedby={[`${id}-hint`, props.error ? `${id}-error` : ''].filter(Boolean).join(' ')}
          aria-invalid={status === 'error' ? true : undefined}
          onChange={event => props.onCodeChange(event.target.value)}
          onPaste={pasted}
        />
        {props.onPasteFromClipboard && !exchanging && <button type="button" className="byos-input-action" aria-label={s.pasteFromClipboard} title={s.pasteFromClipboard} onClick={props.onPasteFromClipboard}><ByosIcon name="paste" size={18}/></button>}
      </div>
      {props.error && <p className="byos-signin-error" id={`${id}-error`} role="alert">{props.error}</p>}
      <button className="byos-signin-primary" type="submit" disabled={empty || exchanging} aria-busy={exchanging || undefined}>{exchanging ? s.exchanging : s.submit}</button>
      <div className="byos-signin-text-actions">
        {status === 'error' && <button className="byos-text-button" type="button" onClick={props.onStart}>{s.reopen} <ByosIcon name="external" size={14}/></button>}
        <button className="byos-text-button" type="button" onClick={props.onCancel}>{s.cancel}</button>
      </div>
    </form>
  </div>;

  return <div className={cls}>
    {nav}
    {/* The stock body only repeats the button; show a host's own line. */}
    {props.strings?.connectBody && <p className="byos-signin-lead">{props.strings.connectBody}</p>}
    {!available && <p className="byos-signin-unavailable" role="status">{s.unavailable}</p>}
    {props.guide && <div className="byos-signin-guide">{props.guide}</div>}
    {props.error && <p className="byos-signin-error" role="alert">{props.error}</p>}
    <button className="byos-signin-primary" type="button" disabled={!available} onClick={props.onStart}>
      <span>{available ? s.connectButton : s.unavailableButton}</span>
      {available && <ByosIcon name="external"/>}
    </button>
    {props.disclosure && <LockNote>{props.disclosure}</LockNote>}
    {(props.remember || props.alternatives?.length || props.privacyDetails) && <SettingsList label={s.privacySummary}>
      {props.remember && <SettingsToggleRow label={s.remember} checked={props.remember.checked} onChange={props.remember.onChange} error={props.remember.error}/>}
      {props.alternatives?.map((alt, i) => <SettingsRow key={i} label={alt.label} onClick={alt.onSelect}/>)}
      {props.privacyDetails && <SettingsRow label={s.privacySummary} onClick={() => setPrivacyOpen(true)}/>}
    </SettingsList>}
  </div>;
}
