import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ByosIcon, type ByosIconName } from './icons.js';

export type AiAccountSettingsTab = 'model' | 'account' | 'tools';

export type AiAccountSettingsStrings = {
  heading: string;
  changeProvider: string;
  modelTab: string;
  accountTab: string;
  toolsTab: string;
  expiredModelNote: string;
  expiredStatus: string;
  connectedStatus: string;
  signedOutStatus: string;
  reconnect: string;
  reconnecting: string;
  /** @deprecated The expired banner now always says `reconnect`; kept so existing string overrides still type-check. */
  openAccountTab: string;
};

export const defaultAiAccountSettingsStrings: AiAccountSettingsStrings = {
  heading: 'AI settings',
  changeProvider: 'Change AI service',
  modelTab: 'Model',
  accountTab: 'Account',
  toolsTab: 'Tools',
  expiredModelNote: 'Reconnect to use AI.',
  expiredStatus: 'Sign-in expired',
  connectedStatus: 'Connected',
  signedOutStatus: 'Not connected',
  reconnect: 'Reconnect',
  reconnecting: 'Connecting…',
  openAccountTab: 'Account',
};

const TAB_ICONS: Record<AiAccountSettingsTab, ByosIconName> = { model: 'sliders', account: 'key', tools: 'tool' };

export type AiAccountSettingsProps = {
  providerName: string;
  headingId?: string;
  expired?: boolean;
  /** False when no account or API key is connected: Account moves first and opens by default. */
  signedIn?: boolean;
  onChangeProvider: () => void;
  modelSettings: ReactNode;
  accountSettings: ReactNode;
  toolsSettings?: ReactNode;
  recoveryAction?: ReactNode;
  /**
   * One-tap reconnect for an expired sign-in, run from the banner above the tabs. Without it the
   * banner's Reconnect button opens Account, where `recoveryAction` and the sign-in methods live.
   */
  onReconnect?: () => void;
  /** Disables the banner's Reconnect button and shows `strings.reconnecting` while a reconnect runs. */
  reconnecting?: boolean;
  /** Provider mark in the header avatar. Defaults to the provider name's first letter. */
  providerIcon?: ReactNode;
  strings?: Partial<AiAccountSettingsStrings>;
  className?: string;
  /** Preserve host-owned sign-in/download state while inactive panes stay hidden. */
  keepPanelsMounted?: boolean;
};

export function AiAccountSettings(props: AiAccountSettingsProps) {
  const generatedId = useId();
  const headingId = props.headingId ?? `${generatedId}-heading`;
  const signedOut = props.signedIn === false;
  // Follow the sign-in default until the user picks a tab, so connecting moves on to Model.
  const [selectedTab, setSelectedTab] = useState<AiAccountSettingsTab | null>(null);
  const activeTab = selectedTab ?? (signedOut ? 'account' : 'model');
  const strings = { ...defaultAiAccountSettingsStrings, ...props.strings };
  const modelTab = { id: 'model' as const, label: strings.modelTab, content: props.modelSettings };
  const accountTab = { id: 'account' as const, label: strings.accountTab, content: <>{props.accountSettings}{props.recoveryAction != null && <div className="byos-account-settings-recovery">{props.recoveryAction}</div>}</> };
  const tabs: { id: AiAccountSettingsTab; label: string; content: ReactNode }[] = [
    ...(signedOut ? [accountTab, modelTab] : [modelTab, accountTab]),
    ...(props.toolsSettings == null ? [] : [{ id: 'tools' as const, label: strings.toolsTab, content: props.toolsSettings }]),
  ];
  const active = tabs.find(tab => tab.id === activeTab) ?? tabs[0];
  const activeTabId = `${generatedId}-${active.id}-tab`;
  const state = props.expired ? 'expired' : props.signedIn === false ? 'signed-out' : props.signedIn === true ? 'connected' : undefined;
  const statusText = state === 'expired' ? strings.expiredStatus : state === 'signed-out' ? strings.signedOutStatus : strings.connectedStatus;
  // With a one-tap reconnect the banner stays on every tab; otherwise it routes to Account, so it hides there.
  const showBanner = props.expired === true && (props.onReconnect != null || active.id !== 'account');
  const panelId = props.keepPanelsMounted ? `${generatedId}-${active.id}-panel` : `${generatedId}-panel`;

  function selectTab(id: AiAccountSettingsTab, focus = false) {
    setSelectedTab(id);
    if (focus) window.requestAnimationFrame(() => document.getElementById(`${generatedId}-${id}-tab`)?.focus());
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex(tab => tab.id === activeTab);
    let next: number | undefined;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next !== undefined) {
      event.preventDefault();
      selectTab(tabs[next].id, true);
    }
  }

  return <section className={`byos byos-account-settings${props.className ? ` ${props.className}` : ''}`} aria-labelledby={headingId}>
    <header className="byos-account-settings-header">
      <h2 id={headingId} tabIndex={-1}>{strings.heading}</h2>
      <div className="byos-account-settings-provider">
        <span className="byos-account-settings-avatar" aria-hidden="true">
          {props.providerIcon ?? props.providerName.trim().charAt(0).toUpperCase()}
          {state && <span className={`byos-account-settings-dot byos-account-settings-dot-${state}`}/>}
        </span>
        <span className="byos-account-settings-identity">
          <strong>{props.providerName}</strong>
          {state && <span className={`byos-account-settings-status byos-account-settings-status-${state}`}>{statusText}</span>}
        </span>
        <button type="button" className="byos-account-settings-change" aria-label={strings.changeProvider} title={strings.changeProvider} onClick={props.onChangeProvider}><ByosIcon name="swap" size={18}/></button>
      </div>
    </header>
    {showBanner && <div className="byos-account-settings-expired" role="status">
      <ByosIcon name="alert" size={16}/>
      <span>{strings.expiredModelNote}</span>
      <button type="button" className="byos-account-settings-reconnect" disabled={props.reconnecting} aria-busy={props.reconnecting || undefined} onClick={() => props.onReconnect ? props.onReconnect() : selectTab('account', true)}>
        <ByosIcon name={props.reconnecting ? 'refresh' : 'plug'} size={15}/>{props.reconnecting ? strings.reconnecting : strings.reconnect}
      </button>
    </div>}
    <div className={`byos-account-settings-tabs byos-account-settings-tabs-${tabs.length}`} role="tablist" aria-label={strings.heading} onKeyDown={onTabKeyDown}>
      {tabs.map(tab => {
        const tabId = `${generatedId}-${tab.id}-tab`;
        return <button key={tab.id} id={tabId} type="button" role="tab" aria-selected={activeTab === tab.id} aria-controls={props.keepPanelsMounted ? `${generatedId}-${tab.id}-panel` : panelId} tabIndex={activeTab === tab.id ? 0 : -1} className="byos-account-settings-tab" onClick={() => selectTab(tab.id)}><ByosIcon name={TAB_ICONS[tab.id]} size={15}/><span>{tab.label}</span></button>;
      })}
    </div>
    {props.keepPanelsMounted ? tabs.map(tab => (
      <div key={tab.id} id={`${generatedId}-${tab.id}-panel`} className="byos-account-settings-panel" role="tabpanel" aria-labelledby={`${generatedId}-${tab.id}-tab`} hidden={active.id !== tab.id}>
        {tab.content}
      </div>
    )) : (
    <div id={panelId} className="byos-account-settings-panel" role="tabpanel" aria-labelledby={activeTabId}>
      {active.content}
    </div>
    )}
  </section>;
}
