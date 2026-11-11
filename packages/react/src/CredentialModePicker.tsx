import { CREDENTIAL_MODES, type CredentialMode } from '@byos/core';

export type CredentialModePickerStrings = {
  label: string;
  selected: string;
  names: Record<CredentialMode, string>;
  descriptions: Record<CredentialMode, string>;
};

export const defaultCredentialModePickerStrings: CredentialModePickerStrings = {
  label: 'How people connect AI',
  selected: 'Selected',
  names: {
    'subscription-and-api-key': 'Subscriptions and API keys',
    subscription: 'Subscriptions only',
    'api-key': 'API keys only',
  },
  descriptions: {
    'subscription-and-api-key': 'Sign in with a plan, or paste a pay-as-you-go API key.',
    subscription: 'Sign in with a plan such as Claude Pro/Max, ChatGPT Plus/Pro or SuperGrok. No API key fields.',
    'api-key': 'Paste a pay-as-you-go API key. No plan sign-in.',
  },
};

export type CredentialModePickerProps = {
  value: CredentialMode;
  onChange: (mode: CredentialMode) => void;
  /** Modes to offer, in order (default: all three). */
  modes?: readonly CredentialMode[];
  strings?: Partial<Omit<CredentialModePickerStrings, 'names' | 'descriptions'>> & {
    names?: Partial<Record<CredentialMode, string>>;
    descriptions?: Partial<Record<CredentialMode, string>>;
  };
  className?: string;
};

/**
 * A radio group for the app's credential mode, for an admin, developer or settings screen. It only
 * reports the choice; the host stores it and passes it to `AiConnectPanel` (`credentialMode`) and to
 * its own request guards (`assertCredentialAllowed`).
 */
export function CredentialModePicker(props: CredentialModePickerProps) {
  const base = defaultCredentialModePickerStrings;
  const strings = {
    ...base,
    ...props.strings,
    names: { ...base.names, ...props.strings?.names },
    descriptions: { ...base.descriptions, ...props.strings?.descriptions },
  };
  const modes = props.modes ?? CREDENTIAL_MODES;
  return <div className={`byos byos-provider-picker byos-credential-mode${props.className ? ` ${props.className}` : ''}`} role="radiogroup" aria-label={strings.label}>
    {modes.map(mode => {
      const selected = mode === props.value;
      return <button key={mode} type="button" role="radio" aria-checked={selected} className={`byos-provider-choice${selected ? ' byos-provider-choice-selected' : ''}`} onClick={() => props.onChange(mode)}>
        <span className="byos-provider-choice-name">{strings.names[mode]}</span>
        <span className="byos-provider-choice-badge">{strings.descriptions[mode]}</span>
        {selected && <span className="byos-provider-choice-selected-label">{strings.selected}</span>}
      </button>;
    })}
  </div>;
}
