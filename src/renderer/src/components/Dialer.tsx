import type { AccountId } from '@core/sip';
import type { AccountView, DialResult } from '../../../shared/api';
import { useTranslation } from '../i18n/TranslatorProvider';
import { useDialer } from '../state/useDialer';
import type { DialerModel } from '../state/useDialer';
import { Button } from './ui/Button';
import { FormField, SelectField } from './ui/Field';
import { Keypad } from './ui/Keypad';

interface DialerProps {
  readonly accounts: readonly AccountView[];
  readonly dial: (accountId: AccountId, target: string) => Promise<DialResult>;
  readonly onDialed: (callId: string) => void;
}

function AccountPicker({ model }: { readonly model: DialerModel }): JSX.Element {
  const { t } = useTranslation();
  const { registered, accountId } = model;
  if (registered.length === 0) return <p className="notice">{t('dialer.noAccount')}</p>;
  const options = registered.map((a) => ({ value: a.account.id, label: `${a.account.displayName} (${a.account.username})` }));
  return (
    <SelectField id="dial-account" label={t('dialer.account')} value={accountId ?? ''} options={options} onChange={model.setAccountId} />
  );
}

function TargetField({ model }: { readonly model: DialerModel }): JSX.Element {
  const { t } = useTranslation();
  return (
    <FormField id="dial-target" label={t('dialer.target')}>
      <div className="dial-input">
        <input
          id="dial-target"
          type="text"
          inputMode="tel"
          autoComplete="off"
          spellCheck={false}
          value={model.target}
          placeholder={t('dialer.placeholder.target')}
          onChange={(event) => model.setTarget(event.target.value)}
        />
        <Button iconOnly icon="backspace" variant="ghost" label={t('dialer.backspace')} onClick={model.backspace} disabled={model.target === ''} />
      </div>
    </FormField>
  );
}

function DialError({ errorKey }: { readonly errorKey: string | null }): JSX.Element | null {
  const { t } = useTranslation();
  if (errorKey === null) return null;
  let text: string;
  try {
    text = t(errorKey);
  } catch {
    text = t('calls.error.failed');
  }
  return (
    <p className="field-error" role="alert">
      {text}
    </p>
  );
}

export function Dialer(props: DialerProps): JSX.Element {
  const { t } = useTranslation();
  const model = useDialer(props);
  const ready = model.accountId !== null && model.target.trim() !== '' && !model.busy;
  return (
    <section className="panel dialer" aria-labelledby="dialer-title">
      <h2 id="dialer-title" className="panel-title">{t('dialer.title')}</h2>
      <form className="dial-form" onSubmit={model.submit}>
        <AccountPicker model={model} />
        <TargetField model={model} />
        <Keypad label={t('dialer.title')} onDigit={model.append} />
        <DialError errorKey={model.errorKey} />
        <Button submit large variant="success" icon="phone" label={t('dialer.call')} disabled={!ready} onClick={() => undefined} />
      </form>
    </section>
  );
}
