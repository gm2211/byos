import type { ReactNode } from 'react';

/**
 * The exact model and effort, both from the provider's own model list. `renderSelect` lets a site
 * drop in its own searchable select; the default is a native <select>.
 */
export type PickerOption = { value: string; label: string; meta?: string };
export type SelectRenderer = (props: { ariaLabel: string; value: string; options: PickerOption[]; onChange: (value: string) => void }) => ReactNode;

export type ModelEffortPickerStrings = {
  model: string;
  effort: string;
  effortFrom: (providerName: string) => string;
  noEffort: (providerName: string) => string;
  providerDefault: string;
  remembered: (providerName: string) => string;
  fallback: (providerName: string) => string;
  retry: string;
};

export const defaultModelEffortStrings: ModelEffortPickerStrings = {
  model: 'MODEL',
  effort: 'EFFORT',
  effortFrom: name => `from ${name}`,
  noEffort: name => `${name} sets the effort itself for this model; it doesn’t offer a choice.`,
  providerDefault: 'Provider default',
  remembered: name => `Couldn't reach ${name} for its model list just now. This is what it last returned.`,
  fallback: name => `Couldn't reach ${name} for its model list yet. This is a fallback list and may be out of date.`,
  retry: 'Retry',
};

export type ModelEffortPickerProps = {
  providerName: string;
  models: PickerOption[];
  model: string;
  onModelChange: (value: string) => void;
  /** Short note beside MODEL, e.g. "12 from Grok". */
  modelNote?: ReactNode;
  efforts: PickerOption[];
  effort: string;
  onEffortChange: (value: string) => void;
  /** 'remembered': last live answer; 'fallback': never reached the provider. */
  staleness?: 'live' | 'remembered' | 'fallback';
  onRetry?: () => void;
  renderSelect?: SelectRenderer;
  strings?: Partial<ModelEffortPickerStrings>;
  classNames?: { root?: string; field?: string; note?: string; retry?: string };
};

const nativeSelect: SelectRenderer = ({ ariaLabel, value, options, onChange }) =>
  <select className="byos-select" aria-label={ariaLabel} value={value} onChange={event => onChange(event.target.value)}>
    {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>;

export function ModelEffortPicker(props: ModelEffortPickerProps) {
  const s = { ...defaultModelEffortStrings, ...props.strings };
  const c = props.classNames ?? {};
  const select = props.renderSelect ?? nativeSelect;
  const field = c.field ?? 'byos-field';
  const note = c.note ?? 'byos-note';
  const stale = props.staleness === 'remembered' || props.staleness === 'fallback';
  return <div className={c.root ?? 'byos byos-model-effort'}>
    <div className={field}>
      <span>{s.model} {props.modelNote && <small>{props.modelNote}</small>}</span>
      {select({ ariaLabel: 'Model', value: props.model, options: props.models, onChange: props.onModelChange })}
    </div>
    {/* Effort is its own setting, always shown: a model without selectable levels still says so in
        the same place, rather than the field disappearing into a note under the model. */}
    <div className={field}>
      <span>{s.effort} {props.efforts.length > 0 && <small>{s.effortFrom(props.providerName)}</small>}</span>
      {props.efforts.length > 0
        ? select({ ariaLabel: 'Effort', value: props.effort, options: props.efforts, onChange: props.onEffortChange })
        : select({ ariaLabel: 'Effort', value: '', options: [{ value: '', label: s.providerDefault }], onChange: () => undefined })}
      {props.efforts.length === 0 && <p className={note}>{s.noEffort(props.providerName)}</p>}
    </div>
    {stale && <p className={note}>{props.staleness === 'remembered' ? s.remembered(props.providerName) : s.fallback(props.providerName)}{props.onRetry && <> <button type="button" className={c.retry ?? 'byos-link-button'} onClick={props.onRetry}>{s.retry}</button></>}</p>}
  </div>;
}
