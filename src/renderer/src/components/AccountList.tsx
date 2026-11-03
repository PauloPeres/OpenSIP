import type { AccountView } from '../../../shared/api';
import type { SipAccount } from '@core/sip';
import { registrationStateKey } from '@core/sip';
import { useTranslation } from '../i18n/TranslatorProvider';
import { ActionButton, StatusBadge } from './StatusBadge';

interface AccountListProps {
  readonly accounts: readonly AccountView[];
  readonly onEdit: (account: SipAccount) => void;
  readonly onRemove: (account: SipAccount) => void;
}

function AccountRow({ view, onEdit, onRemove }: Omit<AccountListProps, 'accounts'> & { readonly view: AccountView }): JSX.Element {
  const { t } = useTranslation();
  const { account, registration } = view;
  return (
    <li className="card row">
      <div className="grow">
        <strong>{account.displayName}</strong>
        <div className="muted">{account.uri}</div>
      </div>
      <StatusBadge tone={registration.state} label={t(registrationStateKey(registration.state))} />
      <ActionButton label={t('accounts.edit')} onClick={() => onEdit(account)} />
      <ActionButton label={t('accounts.remove')} variant="danger" onClick={() => onRemove(account)} />
    </li>
  );
}

export function AccountList({ accounts, onEdit, onRemove }: AccountListProps): JSX.Element {
  const { t } = useTranslation();
  if (accounts.length === 0) return <p className="muted">{t('accounts.empty')}</p>;
  return (
    <ul className="list">
      {accounts.map((view) => (
        <AccountRow key={view.account.id} view={view} onEdit={onEdit} onRemove={onRemove} />
      ))}
    </ul>
  );
}
