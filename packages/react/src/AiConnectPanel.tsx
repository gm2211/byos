import { useId, useState, type FormEvent, type ReactNode } from 'react';
import type { ByosProvider, SignInMethod } from '@byos/core';
import { AiAccountSettings } from './AiAccountSettings.js';
import { AiProviderPicker } from './AiProviderPicker.js';
import { DeviceCodeSignIn, type DeviceCodeSignInProps } from './DeviceCodeSignIn.js';

/**
 * The whole "connect an AI service" surface in one native component: a provider picker, then for
 * the picked service an Account / Model / Preferences panel whose Account tab lists every sign-in
 * method the provider declares (`provider.signIn`, in its order), inline.
 *
 * TOKEN RULE: this panel never sees or sends a token itself. The host's controllers (the
 * `deviceCode`, `pkce`, `apiKey` and `pasteToken` props) run each flow browser-direct, or through the
 * handshake the provider discloses; the panel only renders their state and reports intent through
 * callbacks. A pasted key lives in the host's draft state, never in this component. See
 * docs/customization.md.
 */

export type AiConnectKeyForm = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy?: boolean;
  error?: string;
  caption?: ReactNode;
  placeholder?: string;
};

export type AiConnectPkce = {
  onStart: () => void;
  busy?: boolean;
  error?: string;
  /** Button label; defaults to `strings.signInWith(displayName)`. */
  label?: string;
  caption?: ReactNode;
};

export type AiConnectService = {
  /** Which sign-in methods render comes ONLY from `provider.signIn`, in its order. */
  provider: Pick<ByosProvider, 'id' | 'displayName' | 'signIn'>;
  badge?: ReactNode;
  signedIn: boolean;
  expired?: boolean;
  /** Optional provider note shown above the sign-in methods. */
  notice?: ReactNode;
  /** Host-run flows, one per SignInMethod kind. A declared kind without a controller is not rendered. */
  deviceCode?: Omit<DeviceCodeSignInProps, 'providerName' | 'connected' | 'onDisconnect' | 'compact'>;
  pkce?: AiConnectPkce;
  apiKey?: AiConnectKeyForm;
  pasteToken?: AiConnectKeyForm;
  remember?: { checked: boolean; onChange: (checked: boolean) => void; error?: string };
  onSignOut?: () => void;
  modelSettings: ReactNode;
};

export type AiConnectPanelStrings = {
  heading: string;
  settingsHeading: string;
  pickerLabel: string;
  selected: string;
  backTo: (name: string) => string;
  changeProvider: string;
  modelTab: string;
  accountTab: string;
  preferencesTab: string;
  expiredModelNote: string;
  expiredStatus: string;
  openAccountTab: string;
  or: string;
  signInWith: (name: string) => string;
  apiKeyLabel: string;
  tokenLabel: string;
  connect: string;
  connecting: string;
  setupLabel: string;
  connectedTo: (name: string) => string;
  rememberLabel: string;
  rememberNote: string;
  signOut: (name: string) => string;
};

export const defaultAiConnectPanelStrings: AiConnectPanelStrings = {
  heading: 'Connect AI',
  settingsHeading: 'AI settings',
  pickerLabel: 'Choose an AI service',
  selected: 'Selected',
  backTo: name => `Back to ${name}`,
  changeProvider: 'Change AI service',
  modelTab: 'Model',
  accountTab: 'Account',
  preferencesTab: 'Preferences',
  expiredModelNote: 'Reconnect to use AI.',
  expiredStatus: 'Sign-in expired',
  openAccountTab: 'Account',
  or: 'or',
  signInWith: name => `Sign in with ${name}`,
  apiKeyLabel: 'API key',
  tokenLabel: 'Token',
  connect: 'Connect',
  connecting: 'Connecting…',
  setupLabel: 'Get a key',
  connectedTo: name => `Connected to ${name}`,
  rememberLabel: 'Stay signed in on this device',
  rememberNote: 'Off: sign in again when this tab closes. On: your token is saved in this browser, where scripts on this page can read it.',
  signOut: name => `Sign out of ${name}`,
};

export type AiConnectPanelProps = {
  services: AiConnectService[];
  selectedId?: string;
  onSelect: (id: string) => void;
  heading?: string;
  intro?: ReactNode;
  headingId?: string;
  /** Content of the third ("Preferences") tab. Omitted: no tab. */
  preferences?: ReactNode;
  recoveryAction?: ReactNode;
  strings?: Partial<AiConnectPanelStrings>;
  className?: string;
};

function KeyForm(props: { method: Extract<SignInMethod, { kind: 'api-key' | 'paste-token' }>; form: AiConnectKeyForm; label: string; strings: AiConnectPanelStrings }) {
  const { method, form, label, strings } = props;
  const id = useId();
  const empty = form.value.trim().length === 0;
  const setup = method.kind === 'api-key' ? method.setup : undefined;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!empty && !form.busy) form.onSubmit();
  }
  return <form className="byos-connect-method byos-connect-key" onSubmit={submit}>
    <label className="byos-connect-label" htmlFor={`${id}-input`}>{label}</label>
    {method.hint && <p className="byos-note" id={`${id}-hint`}>{method.hint}</p>}
    {setup && setup.length > 0 && <ol className="byos-connect-setup" aria-label={strings.setupLabel}>
      {setup.map(step => <li key={step.url}><a href={step.url} target="_blank" rel="noopener noreferrer">{step.label}</a></li>)}
    </ol>}
    <input id={`${id}-input`} className="byos-connect-input" type="password" autoComplete="off" spellCheck={false} autoCapitalize="off" value={form.value} placeholder={form.placeholder} aria-describedby={[method.hint ? `${id}-hint` : '', form.error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined} aria-invalid={form.error ? true : undefined} onChange={event => form.onChange(event.target.value)}/>
    <button type="submit" className="byos-connect-primary" disabled={empty || form.busy} aria-busy={form.busy || undefined}>{form.busy ? strings.connecting : strings.connect}</button>
    {form.error && <p className="byos-connect-error" id={`${id}-error`} role="alert">{form.error}</p>}
    {form.caption != null && <p className="byos-note">{form.caption}</p>}
  </form>;
}

function AccountTab({ service, strings }: { service: AiConnectService; strings: AiConnectPanelStrings }) {
  const name = service.provider.displayName;
  const switchId = useId();
  if (service.signedIn) {
    return <div className="byos-connect-account">
      <p className="byos-connect-status" role="status">{strings.connectedTo(name)}</p>
      {service.remember && <div className="byos-connect-remember">
        <button type="button" role="switch" aria-checked={service.remember.checked} aria-describedby={`${switchId}-note`} className="byos-connect-switch-row" onClick={() => service.remember?.onChange(!service.remember.checked)}>
          <span className="byos-connect-switch-text">
            <span className="byos-connect-switch-label">{strings.rememberLabel}</span>
            <span className="byos-note" id={`${switchId}-note`}>{strings.rememberNote}</span>
          </span>
          <span className={`byos-connect-switch${service.remember.checked ? ' byos-connect-switch-on' : ''}`} aria-hidden="true"><span className="byos-connect-switch-thumb"/></span>
        </button>
        {service.remember.error && <p className="byos-connect-error" role="alert">{service.remember.error}</p>}
      </div>}
      {service.onSignOut && <button type="button" className="byos-connect-secondary" onClick={service.onSignOut}>{strings.signOut(name)}</button>}
    </div>;
  }
  const sections: ReactNode[] = [];
  service.provider.signIn.forEach((method, index) => {
    const key = `${method.kind}-${index}`;
    let node: ReactNode = null;
    if (method.kind === 'device-code' && service.deviceCode) {
      node = <div className="byos-connect-method">
        <DeviceCodeSignIn showProviderIdentity={false} helpMode="contextual" {...service.deviceCode} providerName={name} connected={false} onDisconnect={noop} compact/>
      </div>;
    } else if (method.kind === 'pkce' && service.pkce) {
      const pkce = service.pkce;
      node = <div className="byos-connect-method">
        <button type="button" className="byos-connect-primary" disabled={pkce.busy} aria-busy={pkce.busy || undefined} onClick={pkce.onStart}>{pkce.busy ? strings.connecting : pkce.label ?? strings.signInWith(name)}</button>
        {pkce.error && <p className="byos-connect-error" role="alert">{pkce.error}</p>}
        {pkce.caption != null && <p className="byos-note">{pkce.caption}</p>}
      </div>;
    } else if (method.kind === 'api-key' && service.apiKey) {
      node = <KeyForm method={method} form={service.apiKey} label={strings.apiKeyLabel} strings={strings}/>;
    } else if (method.kind === 'paste-token' && service.pasteToken) {
      node = <KeyForm method={method} form={service.pasteToken} label={strings.tokenLabel} strings={strings}/>;
    }
    if (node == null) return;
    if (sections.length > 0) sections.push(<p key={`or-${key}`} className="byos-connect-or" aria-hidden="true"><span>{strings.or}</span></p>);
    sections.push(<div key={key} className="byos-connect-section">{node}</div>);
  });
  return <div className="byos-connect-account">
    {service.notice != null && <div className="byos-connect-notice">{service.notice}</div>}
    {sections}
  </div>;
}

function noop() { /* connected is always false here; sign-out lives in the signed-in view */ }

export function AiConnectPanel(props: AiConnectPanelProps) {
  const strings = { ...defaultAiConnectPanelStrings, ...props.strings };
  const generatedId = useId();
  const headingId = props.headingId ?? `${generatedId}-heading`;
  const [changing, setChanging] = useState(false);
  const service = props.services.find(candidate => candidate.provider.id === props.selectedId);
  const className = `byos byos-connect${props.className ? ` ${props.className}` : ''}`;

  if (!service || changing) {
    return <section className={className} aria-labelledby={headingId}>
      {service && <button type="button" className="byos-connect-back" onClick={() => setChanging(false)}>{strings.backTo(service.provider.displayName)}</button>}
      <h2 id={headingId} tabIndex={-1} className="byos-connect-heading">{props.heading ?? strings.heading}</h2>
      {props.intro != null && <div className="byos-connect-intro">{props.intro}</div>}
      <AiProviderPicker
        className="byos-connect-picker"
        providers={props.services.map(entry => ({ id: entry.provider.id, name: entry.provider.displayName, badge: entry.badge }))}
        selectedId={props.selectedId}
        onSelect={id => { setChanging(false); props.onSelect(id); }}
        strings={{ label: strings.pickerLabel, selected: strings.selected }}
      />
    </section>;
  }

  return <div className={className}>
    <AiAccountSettings
      key={service.provider.id}
      providerName={service.provider.displayName}
      headingId={headingId}
      expired={service.expired}
      signedIn={service.signedIn}
      keepPanelsMounted
      onChangeProvider={() => setChanging(true)}
      modelSettings={service.modelSettings}
      accountSettings={<AccountTab service={service} strings={strings}/>}
      toolsSettings={props.preferences}
      recoveryAction={props.recoveryAction}
      strings={{
        heading: strings.settingsHeading,
        changeProvider: strings.changeProvider,
        modelTab: strings.modelTab,
        accountTab: strings.accountTab,
        toolsTab: strings.preferencesTab,
        expiredModelNote: strings.expiredModelNote,
        expiredStatus: strings.expiredStatus,
        openAccountTab: strings.openAccountTab,
      }}
    />
  </div>;
}
