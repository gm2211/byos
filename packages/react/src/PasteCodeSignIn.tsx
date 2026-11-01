import { useEffect, useId, useRef, type FormEvent, type ReactNode } from 'react';
import { ByosIcon } from './icons.js';

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
  remember?: { checked: boolean; onChange: (checked: boolean) => void; error?: string };
  /** One short line, always visible, saying who can see what during sign-in. */
  disclosure?: ReactNode;
  /** Longer privacy explanation behind a disclosure toggle. */
  privacyDetails?: ReactNode;
  /** Whether to show the provider and plan eyebrow. Defaults to true. */
  showProviderIdentity?: boolean;
  strings?: Partial<PasteCodeSignInStrings>;
  className?: string;
};

export function PasteCodeSignIn(props: PasteCodeSignInProps) {
  const s = { ...defaultPasteCodeStrings(props.providerName), ...props.strings };
  const { status } = props;
  const available = props.available ?? true;
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const exchanging = status === 'exchanging';
  const pasting = status === 'awaiting-code' || status === 'error' || exchanging;
  const empty = props.code.trim().length === 0;
  useEffect(() => { if (status === 'awaiting-code') input.current?.focus(); }, [status]);

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
      />
      {props.error && <p className="byos-signin-error" id={`${id}-error`} role="alert">{props.error}</p>}
      <button className="byos-signin-primary" type="submit" disabled={empty || exchanging} aria-busy={exchanging || undefined}>{exchanging ? s.exchanging : s.submit}</button>
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
