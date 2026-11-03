import type { SipAccount } from '@core/sip';
import { transportLabelKey } from '@core/sip';
import type { AccountView, CallView } from '../../../shared/api';
import { useTranslation } from '../i18n/TranslatorProvider';
import { displayState, stateKey } from '../state/accountState';
import { RegistrationNote } from './RegistrationNote';
import { Avatar, Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Switch } from './ui/Field';

interface AccountListProps {
  readonly accounts: readonly AccountView[];
  readonly calls: readonly CallView[];
  readonly onEdit: (account: SipAccount) => void;
  readonly onRemove: (account: SipAccount) => void;
  readonly onToggle: (account: SipAccount, enabled: boolean) => void;
  /** The account the main process refused to turn off because it has a live call. */
  readonly refusedId: string | null;
}

type RowProps = Omit<AccountListProps, 'accounts' | 'calls'> & {
  readonly view: AccountView;
  readonly index: number;
  readonly busy: boolean;
};

const POWER_KEYS = {
  on: { label: 'accounts.disable', hint: 'accounts.disableHint' }, // i18n-exempt: translation keys
  off: { label: 'accounts.enable', hint: 'accounts.enableHint' } // i18n-exempt: translation keys
} as const;

interface PowerProps {
  readonly view: AccountView;
  readonly onToggle: RowProps['onToggle'];
  readonly refused: boolean;
  readonly busy: boolean;
}

function PowerSwitch({ view, onToggle, refused, busy }: PowerProps): JSX.Element {
  const { t } = useTranslation();
  const on = view.account.enabled;
  const keys = on ? POWER_KEYS.on : POWER_KEYS.off;
  const blocked = on && busy;
  return (
    <div className="account-power">
      <Switch
        id={`power-${view.account.id}`}
        label={t(keys.label)}
        hint={t(keys.hint)}
        checked={on}
        disabled={blocked}
        onChange={(next) => onToggle(view.account, next)}
      />
      {blocked || refused ? <p className="field-error" role="alert">{t('accounts.disableBusy')}</p> : null}
    </div>
  );
}

function AccountIdentity({ view }: { readonly view: AccountView }): JSX.Element {
  const { t } = useTranslation();
  const { account, registration, transport } = view;
  return (
    <div className="account-id">
      <strong>{account.displayName}</strong>
      <span className="mono muted">{account.uri}</span>
      <RegistrationNote registration={registration} failuresOnly />
      {transport === undefined || !view.account.enabled ? null : (
        <span className="muted">{t('registration.transport', { transport: t(transportLabelKey(transport)) })}</span>
      )}
    </div>
  );
}

function AccountRow({ view, index, onEdit, onRemove, onToggle, refusedId, busy }: RowProps): JSX.Element {
  const { t } = useTranslation();
  const { account } = view;
  return (
    <li className="account-row">
      <Avatar name={account.displayName} hue={index} tone={displayState(view)} />
      <AccountIdentity view={view} />
      <Badge tone={displayState(view)} label={t(stateKey(view))} />
      <Button label={t('accounts.edit')} onClick={() => onEdit(account)} />
      <Button label={t('accounts.remove')} variant="danger" onClick={() => onRemove(account)} />
      <PowerSwitch view={view} onToggle={onToggle} refused={refusedId === account.id} busy={busy} />
    </li>
  );
}

function hasLiveCall(calls: readonly CallView[], accountId: string): boolean {
  return calls.some((entry) => entry.call.accountId === accountId && entry.call.state !== 'ended');
}

export function AccountList({ accounts, calls, ...rest }: AccountListProps): JSX.Element {
  const { t } = useTranslation();
  if (accounts.length === 0) return <p className="empty">{t('accounts.empty')}</p>;
  return (
    <ul className="account-list">
      {accounts.map((view, index) => (
        <AccountRow key={view.account.id} view={view} index={index} busy={hasLiveCall(calls, view.account.id)} {...rest} />
      ))}
    </ul>
  );
}
