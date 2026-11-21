import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ByosIcon } from './icons.js';
import { ChatGPTMark } from './ChatGPTMark.js';
import { LockNote, SettingsList, SettingsNav, SettingsRow, SettingsToggleRow } from './SettingsList.js';

/**
 * Device-code subscription sign-in (Codex, Grok...): show a one-time code, send the user to the
 * provider to approve it, wait, then show the connected state. Presentational: the site's connect
 * hook drives `status`/`device`/`error`, and the three callbacks.
 *
 * TOKEN RULE: this component never sees a token. It renders what the connect flow reports.
 */
export type DeviceCodeStatus = 'idle' | 'pending' | 'exchanging' | 'error';
export type DeviceCode = { deviceAuthId: string; userCode: string; verificationUriComplete: string };

export type DeviceCodeSignInStrings = {
  planName: string;
  connectTitle: string;
  connectBody: string;
  connectedTitle: string;
  connectedBody: string;
  connectedUnavailableBody: string;
  preparingTitle: string;
  preparingBody: string;
  codeTitle: string;
  codeBody: string;
  exchangingTitle: string;
  exchangingBody: string;
  unavailable: string;
  connectButton: string;
  retryButton: string;
  unavailableButton: string;
  continueButton: string;
  codeLabel: string;
  copied: string;
  copyFailed: string;
  copyCode: string;
  waiting: string;
  starting: string;
  completing: string;
  cancel: string;
  connectedStatus: string;
  disconnect: string;
  troubleSummary: string;
  troubleBody: string;
  troubleErrorBody?: string;
  remember: string;
  privacySummary: string;
  signInTab: string;
  privacyTab: string;
  helpTab: string;
};

export function defaultDeviceCodeStrings(providerName: string): DeviceCodeSignInStrings {
  return {
    planName: 'Subscription',
    connectTitle: `Connect your ${providerName} account`,
    connectBody: 'Use the subscription you already pay for.',
    connectedTitle: 'You’re connected',
    connectedBody: 'Your account is saved in this browser.',
    connectedUnavailableBody: 'Your account is saved in this browser. It can’t be used right now.',
    preparingTitle: 'Preparing your sign-in',
    preparingBody: 'Asking for a one-time code…',
    codeTitle: `Enter this code at ${providerName}`,
    codeBody: 'Open the link below and enter your one-time code.',
    exchangingTitle: 'Completing your sign-in',
    exchangingBody: 'Finishing sign-in…',
    unavailable: `${providerName} sign-in is unavailable right now.`,
    connectButton: `Connect ${providerName}`,
    retryButton: 'Try again',
    unavailableButton: 'Sign-in unavailable',
    continueButton: `Continue at ${providerName}`,
    codeLabel: 'ONE-TIME CODE',
    copied: 'Copied',
    copyFailed: 'Copy failed — select code',
    copyCode: 'Copy sign-in code',
    waiting: 'Waiting for approval…',
    starting: 'Starting sign-in…',
    completing: 'Completing sign-in…',
    cancel: 'Cancel sign-in',
    connectedStatus: `${providerName} connected`,
    disconnect: `Disconnect ${providerName}`,
    troubleSummary: 'Having trouble signing in?',
    troubleBody: 'Keep this tab open while you approve the code.',
    troubleErrorBody: 'Try signing in again. If the problem continues, check your connection and try again.',
    remember: 'Remember on this browser',
    privacySummary: 'How sign-in and privacy work',
    signInTab: 'Sign in',
    privacyTab: 'Privacy',
    helpTab: 'Help',
  };
}

function SignInCode({ code, strings }: { code: string; strings: DeviceCodeSignInStrings }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  }
  return <div className="byos-signin-code">
    <span className="byos-signin-code-label" role="status">
      {copyState === 'copied' ? strings.copied : copyState === 'error' ? strings.copyFailed : strings.codeLabel}
    </span>
    <div className="byos-signin-code-row">
      <code className="byos-signin-code-value">{code}</code>
      <button className="byos-signin-copy" type="button" aria-label={strings.copyCode} title={copyState === 'copied' ? strings.copied : strings.copyCode} onClick={() => void copyCode()}>
        <ByosIcon name={copyState === 'copied' ? 'check' : 'copy'}/>
      </button>
    </div>
  </div>;
}

export type DeviceCodeSignInProps = {
  providerName: string;
  /** Optional dialog step heading id; makes the heading a programmatic focus target. */
  headingId?: string;
  status: DeviceCodeStatus;
  device: DeviceCode | null;
  error?: string;
  connected: boolean;
  /** False when this build or policy cannot use the provider; sign-in is disabled with a notice. */
  available?: boolean;
  onStart: () => void;
  onCancel: () => void;
  onDisconnect: () => void;
  remember?: { checked: boolean; onChange: (checked: boolean) => void; error?: string };
  /** One short line, always visible, saying who can see what during sign-in. */
  disclosure?: ReactNode;
  /** Longer privacy explanation behind a disclosure toggle. */
  privacyDetails?: ReactNode;
  strings?: Partial<DeviceCodeSignInStrings>;
  /** Link target for the provider approval page; `_self` suits previews. */
  linkTarget?: '_blank' | '_self';
  /** Adds ChatGPT's official monochrome button presentation to device-code sign-in actions. */
  signInBrand?: 'chatgpt';
  /** Compact connected-dialog layout with separate Sign in, Privacy, and Help tabs. */
  compact?: boolean;
  /**
   * Compact only: one flat Sign in view with no Privacy/Help tabs. Order is title, sign-in action,
   * one privacy sentence (`disclosure`), the remember option, then `privacyDetails` behind a toggle,
   * so the primary action is never hidden. Uses the shared primary button (no per-provider brand colour).
   */
  inlinePrivacy?: boolean;
  /** Whether to show the provider and plan eyebrow. Defaults to true. */
  showProviderIdentity?: boolean;
  /** Keep Help as a tab (default), or show it inside Sign in only while a code is pending or sign-in has failed. */
  helpMode?: 'tab' | 'contextual';
  className?: string;
  /**
   * 'list': a settings-style screen (overrides `compact`). A nav row with an icon Back button,
   * one primary button, a lock note, then rows for Remember, any `alternatives`, and "How sign-in
   * works", which drills into `privacyDetails`. While a code is pending: the code, one button to
   * approve it, a status line and Cancel.
   */
  layout?: 'stacked' | 'list';
  /** List layout: shows the icon-only Back button in the nav row. */
  onBack?: () => void;
  backLabel?: string;
  /** List layout: other ways in, as drill-in rows (e.g. "Use an API key instead"). */
  alternatives?: { label: ReactNode; onSelect: () => void }[];
};

export function DeviceCodeSignIn(props: DeviceCodeSignInProps) {
  const s = { ...defaultDeviceCodeStrings(props.providerName), ...props.strings };
  const { status, device, error, connected } = props;
  const available = props.available ?? true;
  const exchanging = status === 'exchanging';
  const pending = !connected && (status === 'pending' || exchanging);
  const title = connected ? s.connectedTitle : pending ? exchanging ? s.exchangingTitle : device ? s.codeTitle : s.preparingTitle : s.connectTitle;
  const body = connected ? available ? s.connectedBody : s.connectedUnavailableBody : pending ? exchanging ? s.exchangingBody : device ? s.codeBody : s.preparingBody : s.connectBody;
  if (props.layout === 'list') return <ListDeviceCodeSignIn props={props} strings={s} pending={pending} exchanging={exchanging} available={available}/>;
  if (props.compact) return <CompactDeviceCodeSignIn props={props} strings={s} pending={pending} exchanging={exchanging} available={available} title={title} body={body}/>;
  return <div className={`byos byos-signin${props.className ? ` ${props.className}` : ''}`}>
    <header className="byos-signin-heading">
      {props.showProviderIdentity !== false && <span className="byos-signin-provider">{props.providerName} <span>{s.planName}</span></span>}
      <h3 id={props.headingId} tabIndex={props.headingId ? -1 : undefined}>{title}</h3>
      <p>{body}</p>
    </header>

    {!available && <p className="byos-signin-unavailable" role="status">{s.unavailable}</p>}
    {props.disclosure && <p className="byos-signin-disclosure">{props.disclosure}</p>}

    {connected ? <div className="byos-signin-connected">
      <p role="status"><ByosIcon name="check"/> {s.connectedStatus}</p>
      <button className="byos-signin-secondary" type="button" onClick={props.onDisconnect}>{s.disconnect}</button>
    </div> : pending ? <div className="byos-signin-device">
      {device && !exchanging && <>
        <SignInCode key={device.deviceAuthId} code={device.userCode} strings={s}/>
        <a className="byos-signin-primary" href={device.verificationUriComplete} target={props.linkTarget ?? '_blank'} rel="noopener noreferrer">{s.continueButton} <ByosIcon name="external"/></a>
      </>}
      <div className="byos-signin-progress">
        <p role="status"><span className="byos-signin-dot" aria-hidden="true"/>{exchanging ? s.completing : device ? s.waiting : s.starting}</p>
        <button className="byos-signin-cancel" type="button" onClick={props.onCancel}>{s.cancel}</button>
      </div>
      {device && !exchanging && <details className="byos-signin-help">
        <summary>{s.troubleSummary}</summary>
        <p>{s.troubleBody}</p>
      </details>}
    </div> : <>
      {error && <p className="byos-signin-error" role="alert">{error}</p>}
      <DeviceCodeStartButton props={props} available={available} label={!available ? s.unavailableButton : status === 'error' ? s.retryButton : s.connectButton}/>
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

function DeviceCodeStartButton({ props, label, available }: { props: DeviceCodeSignInProps; label: string; available: boolean }) {
  const flat = props.compact && props.inlinePrivacy;
  const brandClass = props.signInBrand === 'chatgpt' && !flat ? ' byos-chatgpt-identity-button byos-chatgpt-identity-black' : '';
  return <button className={`byos-signin-primary${brandClass}`} type="button" disabled={!available} onClick={props.onStart}>
    {props.signInBrand === 'chatgpt' && !flat && <ChatGPTMark variant="black"/>}
    <span>{label}</span>
    {available && !flat && props.signInBrand !== 'chatgpt' && <ByosIcon name="external"/>}
  </button>;
}

function CompactDeviceCodeSignIn({ props, strings, pending, exchanging, available, title, body }: {
  props: DeviceCodeSignInProps;
  strings: DeviceCodeSignInStrings;
  pending: boolean;
  exchanging: boolean;
  available: boolean;
  title: string;
  body: string;
}) {
  const id = useId();
  const [activeTab, setActiveTab] = useState<'signin' | 'privacy' | 'help'>('signin');
  const contextualHelpAvailable = props.helpMode === 'contextual';
  const showContextualHelp = contextualHelpAvailable && ((pending && !!props.device && !exchanging) || props.status === 'error');
  const tabs = [
    { id: 'signin' as const, label: strings.signInTab },
    { id: 'privacy' as const, label: strings.privacyTab },
    ...(contextualHelpAvailable ? [] : [{ id: 'help' as const, label: strings.helpTab }]),
  ];
  const selectedTab = tabs.some(tab => tab.id === activeTab) ? activeTab : 'signin';
  useEffect(() => {
    if (selectedTab !== activeTab) setActiveTab(selectedTab);
  }, [activeTab, selectedTab]);
  function activate(index: number, focus = false) {
    const tab = tabs[index];
    setActiveTab(tab.id);
    if (focus) window.requestAnimationFrame(() => document.getElementById(`${id}-${tab.id}-tab`)?.focus());
  }
  function onTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex(tab => tab.id === selectedTab);
    let next: number | undefined;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next !== undefined) { event.preventDefault(); activate(next, true); }
  }
  const panelId = `${id}-panel`;
  const activeTabId = `${id}-${selectedTab}-tab`;
  const showInitialDisclosure = !props.connected && !pending && props.status !== 'error';
  const inline = props.inlinePrivacy === true;
  const disclosureNode = props.disclosure ? <p className="byos-signin-disclosure">{props.disclosure}</p> : null;

  return <div className={`byos byos-signin byos-signin-compact${props.className ? ` ${props.className}` : ''}`}>
    <header className="byos-signin-heading byos-signin-compact-heading">
      {props.showProviderIdentity !== false && <span className="byos-signin-provider">{props.providerName} <span>{strings.planName}</span></span>}
      <h3 id={props.headingId} tabIndex={props.headingId ? -1 : undefined}>{title}</h3>
      {(!pending || exchanging) && <p>{body}</p>}
    </header>
    {!inline && <div className={`byos-signin-compact-tabs${contextualHelpAvailable ? ' byos-signin-compact-tabs-two' : ''}`} role="tablist" aria-label={strings.privacySummary} onKeyDown={onTabKeyDown}>
      {tabs.map((tab, index) => <button key={tab.id} id={`${id}-${tab.id}-tab`} type="button" role="tab" aria-selected={selectedTab === tab.id} aria-controls={panelId} tabIndex={selectedTab === tab.id ? 0 : -1} onClick={() => activate(index)}>{tab.label}</button>)}
    </div>}
    <div className="byos-signin-compact-panel" id={panelId} role={inline ? undefined : 'tabpanel'} aria-labelledby={inline ? undefined : activeTabId}>
      {selectedTab === 'signin' && <>
        {!available && <p className="byos-signin-unavailable" role="status">{strings.unavailable}</p>}
        {!inline && showInitialDisclosure && disclosureNode}
        {props.connected ? <div className="byos-signin-connected byos-signin-compact-connected">
          <p role="status"><ByosIcon name="check"/> {strings.connectedStatus}</p>
          <button className="byos-signin-secondary" type="button" onClick={props.onDisconnect}>{strings.disconnect}</button>
        </div> : pending ? <div className="byos-signin-device byos-signin-compact-device">
          {props.device && !exchanging && <>
            <SignInCode key={props.device.deviceAuthId} code={props.device.userCode} strings={strings}/>
            <a className="byos-signin-primary" href={props.device.verificationUriComplete} target={props.linkTarget ?? '_blank'} rel="noopener noreferrer">{strings.continueButton} <ByosIcon name="external"/></a>
          </>}
          <div className="byos-signin-progress">
            <p role="status"><span className="byos-signin-dot" aria-hidden="true"/>{exchanging ? strings.completing : props.device ? strings.waiting : strings.starting}</p>
            <button className="byos-signin-cancel" type="button" onClick={props.onCancel}>{strings.cancel}</button>
          </div>
        </div> : <>
          {props.error && <p className="byos-signin-error" role="alert">{props.error}</p>}
          <DeviceCodeStartButton props={props} available={available} label={!available ? strings.unavailableButton : props.status === 'error' ? strings.retryButton : strings.connectButton}/>
        </>}
        {showContextualHelp && <details className="byos-signin-help"><summary>{strings.troubleSummary}</summary><p>{props.status === 'error' ? strings.troubleErrorBody ?? strings.troubleBody : strings.troubleBody}</p></details>}
        {inline && !props.connected && <>
          {disclosureNode}
          {props.remember && <div className="byos-signin-storage byos-signin-compact-storage">
            <label><input type="checkbox" checked={props.remember.checked} onChange={event => props.remember!.onChange(event.target.checked)}/><span>{strings.remember}</span></label>
            {props.remember.error && <p className="byos-signin-storage-error" role="alert">{props.remember.error}</p>}
          </div>}
          {props.privacyDetails && <details className="byos-signin-privacy byos-signin-inline-privacy"><summary>{strings.privacySummary}</summary>{props.privacyDetails}</details>}
        </>}
      </>}
      {!inline && selectedTab === 'privacy' && <div className="byos-signin-compact-support" role="region" aria-label={strings.privacyTab} tabIndex={0}>
        {props.remember && <div className="byos-signin-storage byos-signin-compact-storage">
          <label><input type="checkbox" checked={props.remember.checked} onChange={event => props.remember!.onChange(event.target.checked)}/><span>{strings.remember}</span></label>
          {props.remember.error && <p className="byos-signin-storage-error" role="alert">{props.remember.error}</p>}
        </div>}
        <div className="byos-signin-compact-privacy-content">{props.privacyDetails ?? <p>{strings.privacySummary}</p>}</div>
      </div>}
      {!inline && selectedTab === 'help' && <div className="byos-signin-compact-support" role="region" aria-label={strings.helpTab} tabIndex={0}><p>{strings.troubleBody}</p></div>}
    </div>
  </div>;
}

function ListDeviceCodeSignIn({ props, strings, pending, exchanging, available }: {
  props: DeviceCodeSignInProps;
  strings: DeviceCodeSignInStrings;
  pending: boolean;
  exchanging: boolean;
  available: boolean;
}) {
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const back = props.backLabel ?? 'Back';
  const cls = `byos byos-signin byos-signin-list${props.className ? ` ${props.className}` : ''}`;
  if (privacyOpen && props.privacyDetails) return <div className={cls}>
    <SettingsNav title={strings.privacySummary} onBack={() => setPrivacyOpen(false)} backLabel={back} headingId={props.headingId}/>
    <div className="byos-signin-privacy-page">{props.privacyDetails}</div>
  </div>;
  const nav = <SettingsNav title={props.providerName} detail={props.showProviderIdentity === false ? undefined : strings.planName} onBack={props.onBack} backLabel={back} headingId={props.headingId}/>;
  if (props.connected) return <div className={cls}>
    {nav}
    <SettingsList>
      <SettingsRow label={strings.connectedStatus} trailing={<span className="byos-list-row-check"><ByosIcon name="check" size={16}/></span>}/>
      <SettingsRow label={strings.disconnect} tone="danger" onClick={props.onDisconnect}/>
    </SettingsList>
  </div>;
  if (pending) return <div className={cls}>
    {nav}
    {props.device && !exchanging && <>
      <p className="byos-signin-lead">{strings.codeBody}</p>
      <SignInCode key={props.device.deviceAuthId} code={props.device.userCode} strings={strings}/>
      <a className="byos-signin-primary" href={props.device.verificationUriComplete} target={props.linkTarget ?? '_blank'} rel="noopener noreferrer">{strings.continueButton} <ByosIcon name="external"/></a>
    </>}
    <div className="byos-signin-progress">
      <p role="status"><span className="byos-signin-dot" aria-hidden="true"/>{exchanging ? strings.completing : props.device ? strings.waiting : strings.starting}</p>
      <button className="byos-text-button" type="button" onClick={props.onCancel}>{strings.cancel}</button>
    </div>
  </div>;
  return <div className={cls}>
    {nav}
    {!available && <p className="byos-signin-unavailable" role="status">{strings.unavailable}</p>}
    {props.error && <p className="byos-signin-error" role="alert">{props.error}</p>}
    <button className="byos-signin-primary" type="button" disabled={!available} onClick={props.onStart}>
      <span>{!available ? strings.unavailableButton : props.status === 'error' ? strings.retryButton : strings.connectButton}</span>
      {available && <ByosIcon name="external"/>}
    </button>
    {props.disclosure && <LockNote>{props.disclosure}</LockNote>}
    {(props.remember || props.alternatives?.length || props.privacyDetails) && <SettingsList label={strings.privacySummary}>
      {props.remember && <SettingsToggleRow label={strings.remember} checked={props.remember.checked} onChange={props.remember.onChange} error={props.remember.error}/>}
      {props.alternatives?.map((alt, i) => <SettingsRow key={i} label={alt.label} onClick={alt.onSelect}/>)}
      {props.privacyDetails && <SettingsRow label={strings.privacySummary} onClick={() => setPrivacyOpen(true)}/>}
    </SettingsList>}
  </div>;
}
