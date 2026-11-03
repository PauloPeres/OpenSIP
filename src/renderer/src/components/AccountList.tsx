import type { SipAccount } from '@core/sip';
import { registrationStateKey, transportLabelKey } from '@core/sip';
import type { AccountView } from '../../../shared/api';
import { useTranslation } from '../i18n/TranslatorProvider';
import { Avatar, Badge } from './ui/Badge';
import { Button } from './ui/Button';

interface AccountListProps {
  readonly accounts: readonly AccountView[];
  readonly onEdit: (account: SipAccount) => void;
  readonly onRemove: (account: SipAccount) => void;
}

type RowProps = Omit<AccountListProps, 'accounts'> & { readonly view: AccountView; readonly index: number };

function AccountRow({ view, index, onEdit, onRemove }: RowProps): JSX.Element {
  const { t } = useTranslation();
  const { account, registration, transport } = view;
  return (
    <li className="account-row">
      <Avatar name={account.displayName} hue={index} tone={registration.state} />
      <div className="account-id">
        <strong>{account.displayName}</strong>
        <span className="mono muted">{account.uri}</span>
        {transport === undefined ? null : (
          <span className="muted">{t('registration.transport', { transport: t(transportLabelKey(transport)) })}</span>
        )}
      </div>
      <Badge tone={registration.state} label={t(registrationStateKey(registration.state))} />
      <Button label={t('accounts.edit')} onClick={() => onEdit(account)} />
      <Button label={t('accounts.remove')} variant="danger" onClick={() => onRemove(account)} />
    </li>
  );
}

export function AccountList({ accounts, onEdit, onRemove }: AccountListProps): JSX.Element {
  const { t } = useTranslation();
  if (accounts.length === 0) return <p className="empty">{t('accounts.empty')}</p>;
  return (
    <ul className="account-list">
      {accounts.map((view, index) => (
        <AccountRow key={view.account.id} view={view} index={index} onEdit={onEdit} onRemove={onRemove} />
      ))}
    </ul>
  );
}
