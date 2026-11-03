import { useState } from 'react';
import type { FormEvent } from 'react';
import type { SipAccount, SipAccountInput, ValidationIssue } from '@core/sip';
import type { AccountDraft, SaveAccountResult } from '../../../shared/api';
import { useTranslation } from '../i18n/TranslatorProvider';
import { Button } from './ui/Button';
import { FormField } from './ui/Field';

type FieldName = keyof SipAccountInput;
type Values = Readonly<Record<FieldName, string>>;

interface FieldDef {
  readonly name: FieldName;
  readonly placeholder: boolean;
  readonly type: string;
}

const BASIC_FIELDS: readonly FieldDef[] = [
  { name: 'username', placeholder: true, type: 'text' },
  { name: 'password', placeholder: false, type: 'password' },
  { name: 'domain', placeholder: true, type: 'text' }
];

const ADVANCED_FIELDS: readonly FieldDef[] = [
  { name: 'serverUri', placeholder: true, type: 'text' }, // i18n-exempt: field name
  { name: 'registerExpires', placeholder: false, type: 'number' } // i18n-exempt: field name
];

const BLANK: Values = {
  displayName: '',
  username: '',
  password: '',
  domain: '',
  serverUri: '',
  registerExpires: ''
};

function toValues(account: SipAccount | undefined): Values {
  if (account === undefined) return BLANK;
  return { ...account, serverUri: account.serverUri ?? '', registerExpires: String(account.registerExpires) };
}

/** The display name is not asked for: it defaults to the username unless one already exists. */
function toDraft(values: Values, id: string | undefined): AccountDraft {
  const { registerExpires, serverUri, displayName, ...rest } = values;
  const expires = registerExpires.trim() === '' ? {} : { registerExpires: Number(registerExpires) };
  const server = serverUri.trim() === '' ? {} : { serverUri };
  return {
    ...rest,
    displayName: displayName.trim() === '' ? values.username : displayName,
    ...server,
    ...expires,
    ...(id === undefined ? {} : { id })
  };
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
    <FormField id={def.name} label={t(`accounts.field.${def.name}`)}>
      <input
        id={def.name}
        type={def.type}
        value={value}
        placeholder={placeholder}
        aria-invalid={issues.length > 0}
        onChange={(event) => onChange(def.name, event.target.value)}
      />
      <FieldErrors issues={issues} />
    </FormField>
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
      <Button submit variant="primary" label={t('accounts.save')} onClick={() => undefined} />
      <Button label={t('accounts.cancel')} onClick={onCancel} />
    </div>
  );
}

interface FieldGroupProps {
  readonly defs: readonly FieldDef[];
  readonly values: Values;
  readonly issues: readonly ValidationIssue[];
  readonly onChange: (name: FieldName, value: string) => void;
}

function FieldGroup({ defs, values, issues, onChange }: FieldGroupProps): JSX.Element {
  return (
    <>
      {defs.map((def) => (
        <Field
          key={def.name}
          def={def}
          value={values[def.name]}
          issues={issues.filter((issue) => issue.field === def.name)}
          onChange={onChange}
        />
      ))}
    </>
  );
}

export function AccountForm(props: AccountFormProps): JSX.Element {
  const { values, issues, change, submit } = useAccountForm(props);
  const { t } = useTranslation();
  const group = { values, issues, onChange: change };
  const advancedHasIssue = issues.some((issue) => ADVANCED_FIELDS.some((def) => def.name === issue.field));
  return (
    <form className="panel form" onSubmit={submit}>
      <FieldGroup defs={BASIC_FIELDS} {...group} />
      <details open={advancedHasIssue || undefined}>
        <summary>{t('accounts.advanced')}</summary>
        <FieldGroup defs={ADVANCED_FIELDS} {...group} />
      </details>
      <FormActions onCancel={props.onDone} />
    </form>
  );
}
