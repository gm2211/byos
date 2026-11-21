import type { ReactNode } from 'react';
import { ProviderAvatar, SettingsList, SettingsRow } from './SettingsList.js';
import { ByosIcon } from './icons.js';

export type AiProviderChoice = {
  id: string;
  name: string;
  badge?: ReactNode;
  /** List layout: second line under the name (e.g. "Pro or Max plan"). Falls back to `badge`. */
  description?: ReactNode;
  /** List layout: the provider's mark. Defaults to the name's first letter. */
  icon?: ReactNode;
  /** List layout: the id of the group (from `groups`) this choice is listed under. */
  group?: string;
};

export type AiProviderPickerStrings = {
  label: string;
  selected: string;
};

export const defaultAiProviderPickerStrings: AiProviderPickerStrings = {
  label: 'Choose an AI service',
  selected: 'Selected',
};

export type AiProviderPickerProps = {
  providers: AiProviderChoice[];
  selectedId?: string;
  onSelect: (providerId: string) => void;
  strings?: Partial<AiProviderPickerStrings>;
  className?: string;
  /**
   * 'buttons' (default): a column of bordered buttons. 'list': grouped settings-style rows with an
   * avatar, a one-line description and a chevron, split under `groups` headings.
   */
  layout?: 'buttons' | 'list';
  /** List layout: ordered group headings, e.g. "Use your plan" and "Use an API key". */
  groups?: { id: string; label: ReactNode }[];
};

/** A short, application-owned provider choice list. It does not connect or authenticate providers. */
export function AiProviderPicker(props: AiProviderPickerProps) {
  const strings = { ...defaultAiProviderPickerStrings, ...props.strings };
  if (props.layout === 'list') {
    const groups = props.groups?.length ? props.groups : [{ id: '', label: undefined as ReactNode }];
    const grouped = groups.map(group => ({
      ...group,
      providers: props.providers.filter(p => props.groups?.length ? p.group === group.id : true),
    }));
    // A choice whose group isn't listed still shows, after the groups.
    const loose = props.groups?.length ? props.providers.filter(p => !props.groups!.some(g => g.id === p.group)) : [];
    if (loose.length) grouped.push({ id: '', label: undefined, providers: loose });
    return <div className={`byos byos-provider-picker byos-provider-picker-list${props.className ? ` ${props.className}` : ''}`} role="group" aria-label={strings.label}>
      {grouped.filter(g => g.providers.length).map((group, index) => <SettingsList key={group.id || `g${index}`} heading={group.label}>
        {group.providers.map(provider => {
          const selected = provider.id === props.selectedId;
          return <SettingsRow key={provider.id} className="byos-provider-choice" selected={selected}
            icon={<ProviderAvatar name={provider.name} icon={provider.icon}/>}
            label={<span className="byos-provider-choice-name">{provider.name}</span>}
            detail={provider.description ?? provider.badge}
            trailing={selected
              ? <span className="byos-list-row-check"><ByosIcon name="check" size={16}/><span className="byos-provider-choice-selected-label byos-visually-hidden">{strings.selected}</span></span>
              : undefined}
            onClick={() => props.onSelect(provider.id)}/>;
        })}
      </SettingsList>)}
    </div>;
  }
  return <div className={`byos byos-provider-picker${props.className ? ` ${props.className}` : ''}`} role="group" aria-label={strings.label}>
    {props.providers.map(provider => {
      const selected = provider.id === props.selectedId;
      return <button key={provider.id} type="button" className={`byos-provider-choice${selected ? ' byos-provider-choice-selected' : ''}`} aria-pressed={selected} onClick={() => props.onSelect(provider.id)}>
        <span className="byos-provider-choice-name">{provider.name}</span>
        {provider.badge != null && <span className="byos-provider-choice-badge">{provider.badge}</span>}
        {selected && <span className="byos-provider-choice-selected-label">{strings.selected}</span>}
      </button>;
    })}
  </div>;
}
