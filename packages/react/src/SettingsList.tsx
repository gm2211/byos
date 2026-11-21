import { useId, type ReactNode } from 'react';
import { ByosIcon, type ByosIconName } from './icons.js';

/**
 * Settings-style list primitives: grouped rows like a phone's Settings app. Every BYOS screen in the
 * `layout="list"` presentation is built from these, and hosts use them for their own rows (the
 * account options of `AiAccountSettings`, say) so everything lines up.
 */

/** A titled group of rows. `heading` is a short uppercase label above the group. */
export function SettingsList(props: { heading?: ReactNode; label?: string; children: ReactNode; className?: string }) {
  const id = useId();
  return <div className={`byos-list-group${props.className ? ` ${props.className}` : ''}`}>
    {props.heading != null && <h4 className="byos-list-heading" id={`${id}-heading`}>{props.heading}</h4>}
    <div className="byos-list" role="group" aria-labelledby={props.heading != null ? `${id}-heading` : undefined} aria-label={props.heading == null ? props.label : undefined}>{props.children}</div>
  </div>;
}

export type SettingsRowProps = {
  label: ReactNode;
  /** Second line under the label (plan, status). */
  detail?: ReactNode;
  /** Current value, right-aligned before the chevron (e.g. the chosen model). */
  value?: ReactNode;
  /** Leading avatar or icon. */
  icon?: ReactNode;
  /** Makes the row a button that drills in (chevron) or acts. */
  onClick?: () => void;
  /** Makes the row a link; `external` draws an outward arrow instead of the chevron. */
  href?: string;
  external?: boolean;
  /** 'danger' centres a red label (Disconnect); 'accent' colours the label. */
  tone?: 'danger' | 'accent';
  /** Shown instead of the chevron, e.g. a check for the chosen option or a small action button. */
  trailing?: ReactNode;
  /** Marks the chosen option (aria-pressed on a button row). */
  selected?: boolean;
  ariaLabel?: string;
  className?: string;
};

export function SettingsRow(props: SettingsRowProps) {
  const cls = `byos-list-row${props.tone ? ` byos-list-row-${props.tone}` : ''}${props.selected ? ' byos-list-row-selected' : ''}${props.className ? ` ${props.className}` : ''}`;
  const interactive = props.onClick != null || props.href != null;
  const trailing = props.trailing ?? (props.tone === 'danger' ? null : interactive ? <span className="byos-list-row-chevron" aria-hidden="true"><ByosIcon name={props.external ? 'external' : 'chevron-right'} size={16}/></span> : null);
  const content = <>
    {props.icon != null && <span className="byos-list-row-icon">{props.icon}</span>}
    <span className="byos-list-row-text">
      <span className="byos-list-row-label">{props.label}</span>
      {props.detail != null && <span className="byos-list-row-detail">{props.detail}</span>}
    </span>
    {props.value != null && <span className="byos-list-row-value">{props.value}</span>}
    {trailing}
  </>;
  if (props.href != null) return <a className={cls} href={props.href} target={props.external ? '_blank' : undefined} rel={props.external ? 'noopener noreferrer' : undefined} aria-label={props.ariaLabel}>{content}</a>;
  if (props.onClick != null) return <button type="button" className={cls} onClick={props.onClick} aria-label={props.ariaLabel} aria-pressed={props.selected === undefined ? undefined : props.selected}>{content}</button>;
  return <div className={cls}>{content}</div>;
}

/** An on/off row drawn as a switch; it is a real checkbox with role="switch". */
export function SettingsToggleRow(props: { label: ReactNode; checked: boolean; onChange: (checked: boolean) => void; detail?: ReactNode; error?: string; disabled?: boolean }) {
  const id = useId();
  return <>
    <label className="byos-list-row byos-list-row-toggle" htmlFor={id}>
      <span className="byos-list-row-text">
        <span className="byos-list-row-label">{props.label}</span>
        {props.detail != null && <span className="byos-list-row-detail">{props.detail}</span>}
      </span>
      <input id={id} type="checkbox" role="switch" className="byos-switch" checked={props.checked} disabled={props.disabled} aria-checked={props.checked} onChange={event => props.onChange(event.target.checked)}/>
    </label>
    {props.error && <p className="byos-list-row-error" role="alert">{props.error}</p>}
  </>;
}

/** The top of a drilled-in screen: an icon-only Back button, the title and an optional short detail. */
export function SettingsNav(props: { title: ReactNode; detail?: ReactNode; onBack?: () => void; backLabel?: string; headingId?: string }) {
  const back = props.backLabel ?? 'Back';
  return <div className="byos-list-nav">
    {props.onBack && <button type="button" className="byos-list-nav-back" aria-label={back} title={back} onClick={props.onBack}><ByosIcon name="chevron-left" size={20}/></button>}
    <h3 id={props.headingId} tabIndex={props.headingId ? -1 : undefined}>{props.title}{props.detail != null && <span className="byos-list-nav-detail">{props.detail}</span>}</h3>
  </div>;
}

/** One quiet line with a lock: who can see the sign-in. Replaces the boxed disclosure. */
export function LockNote(props: { children: ReactNode; icon?: ByosIconName }) {
  return <p className="byos-lock-note"><ByosIcon name={props.icon ?? 'lock'} size={14}/><span>{props.children}</span></p>;
}

/** A leading square avatar: the host's mark, or the name's first letter. */
export function ProviderAvatar(props: { name: string; icon?: ReactNode; state?: 'connected' | 'expired' | 'signed-out' }) {
  return <span className="byos-list-avatar" aria-hidden="true">
    {props.icon ?? props.name.trim().charAt(0).toUpperCase()}
    {props.state && <span className={`byos-account-settings-dot byos-account-settings-dot-${props.state}`}/>}
  </span>;
}
