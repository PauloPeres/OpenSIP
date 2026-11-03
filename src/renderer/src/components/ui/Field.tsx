import type { ReactNode } from 'react';

export function FormField({ id, label, children }: { readonly id: string; readonly label: string; readonly children: ReactNode }): JSX.Element {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
    </div>
  );
}

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

interface SelectFieldProps {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly onChange: (value: string) => void;
}

export function SelectField({ id, label, value, options, onChange }: SelectFieldProps): JSX.Element {
  return (
    <FormField id={id} label={label}>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FormField>
  );
}

export function Switch({ id, label, hint, checked, onChange }: {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
}): JSX.Element {
  return (
    <div className="switch">
      <input id={id} type="checkbox" role="switch" checked={checked} aria-describedby={`${id}-hint`} onChange={(e) => onChange(e.target.checked)} />
      <label htmlFor={id}>{label}</label>
      <span id={`${id}-hint`} className="hint">{hint}</span>
    </div>
  );
}
