import { useState } from 'react';
import type { FormEvent } from 'react';
import type { SipAccount, SipAccountInput, ValidationIssue } from '@core/sip';
import type { AccountDraft, SaveAccountResult } from '../../../shared/api';
import { useTranslation } from '../i18n/TranslatorProvider';
import { ActionButton } from './StatusBadge';

type FieldName = keyof SipAccountInput;
type Values = Readonly<Record<FieldName, string>>;

interface FieldDef {
  readonly name: FieldName;
  readonly placeholder: boolean;
  readonly type: string;
}

const FIELDS: readonly FieldDef[] = [
  { name: 'displayName', placeholder: true, type: 'text' }, // i18n-exempt: field name
  { name: 'username', placeholder: true, type: 'text' },
  { name: 'password', placeholder: false, type: 'password' },
  { name: 'domain', placeholder: true, type: 'text' },
  { name: 'wsServer', placeholder: true, type: 'text' }, // i18n-exempt: field name
  { name: 'registerExpires', placeholder: false, type: 'number' } // i18n-exempt: field name
];

const BLANK: Values = {
  displayName: '',
  username: '',
  password: '',
  domain: '',
  wsServer: '',
  registerExpires: ''
};

function toValues(account: SipAccount | undefined): Values {
  if (account === undefined) return BLANK;
  return { ...account, registerExpires: String(account.registerExpires) };
}

function toDraft(values: Values, id: string | undefined): AccountDraft {
  const { registerExpires, ...rest } = values;
  const expires = registerExpires.trim() === '' ? {} : { registerExpires: Number(registerExpires) };
  return { ...rest, ...expires, ...(id === undefined ? {} : { id }) };
}

interface FieldProps {
  readonly def: FieldDef;
  readonly value: string;
  readonly issues: readonly ValidationIssue[];
  readonly onChange: (name: FieldName, value: string) => void;
}

function FieldErrors({ issues }: { readonly issues: readonly ValidationIssue[] }): JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      {issues.map((issue) => (
        <span key={issue.messageKey} className="field-error" role="alert">
          {t(issue.messageKey)}
        </span>
      ))}
    </>
  );
}

function Field({ def, value, issues, onChange }: FieldProps): JSX.Element {
  const { t } = useTranslation();
  const placeholder = def.placeholder ? t(`accounts.placeholder.${def.name}`) : undefined;
  return (
    <div className="field">
      <label htmlFor={def.name}>{t(`accounts.field.${def.name}`)}</label>
      <input
        id={def.name}
        type={def.type}
        value={value}
        placeholder={placeholder}
        aria-invalid={issues.length > 0}
        onChange={(event) => onChange(def.name, event.target.value)}
      />
      <FieldErrors issues={issues} />
    </div>
  );
}

interface AccountFormProps {
  readonly initial?: SipAccount;
  readonly onSave: (draft: AccountDraft) => Promise<SaveAccountResult>;
  readonly onDone: () => void;
}

interface FormModel {
  readonly values: Values;
  readonly issues: readonly ValidationIssue[];
  readonly change: (name: FieldName, value: string) => void;
  readonly submit: (event: FormEvent) => void;
}

function useAccountForm({ initial, onSave, onDone }: AccountFormProps): FormModel {
  const [values, setValues] = useState<Values>(() => toValues(initial));
  const [issues, setIssues] = useState<readonly ValidationIssue[]>([]);
  const change = (name: FieldName, value: string): void =>
    setValues((current) => ({ ...current, [name]: value }));
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onSave(toDraft(values, initial?.id))
      .then((result) => (result.ok ? onDone() : setIssues(result.issues)))
      .catch(() => setIssues([]));
  };
  return { values, issues, change, submit };
}

function FormActions({ onCancel }: { readonly onCancel: () => void }): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="row">
      <ActionButton submit variant="primary" label={t('accounts.save')} onClick={() => undefined} />
      <ActionButton label={t('accounts.cancel')} onClick={onCancel} />
    </div>
  );
}

export function AccountForm(props: AccountFormProps): JSX.Element {
  const { values, issues, change, submit } = useAccountForm(props);
  return (
    <form className="card form" onSubmit={submit}>
      {FIELDS.map((def) => (
        <Field
          key={def.name}
          def={def}
          value={values[def.name]}
          issues={issues.filter((issue) => issue.field === def.name)}
          onChange={change}
        />
      ))}
      <FormActions onCancel={props.onDone} />
    </form>
  );
}
