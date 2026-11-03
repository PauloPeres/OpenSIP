import { registrationStateKey } from '@core/sip';
import type { AccountView } from '../../../shared/api';
import { useTranslation } from '../i18n/TranslatorProvider';
import { Avatar } from './ui/Badge';
import { cx } from './ui/cx';
import { Icon } from './ui/Icon';
import type { IconName } from './ui/Icon';

export type ViewId = 'calls' | 'accounts' | 'logs' | 'settings';

const NAV: readonly { readonly id: ViewId; readonly labelKey: string; readonly icon: IconName }[] = [
  { id: 'calls', labelKey: 'nav.calls', icon: 'phone' },
  { id: 'accounts', labelKey: 'nav.accounts', icon: 'users' },
  { id: 'logs', labelKey: 'nav.logs', icon: 'list' },
  { id: 'settings', labelKey: 'nav.settings', icon: 'sliders' }
];

interface SidebarProps {
  readonly view: ViewId;
  readonly onView: (id: ViewId) => void;
  readonly accounts: readonly AccountView[];
}

function AccountStatus({ accounts }: { readonly accounts: readonly AccountView[] }): JSX.Element {
  const { t } = useTranslation();
  return (
    <ul className="status-list">
      {accounts.map((view, index) => (
        <li key={view.account.id} className="status-item">
          <Avatar name={view.account.displayName} hue={index} tone={view.registration.state} />
          <span className="status-text">
            <span className="status-name">{view.account.displayName}</span>
            <span className="status-state">{t(registrationStateKey(view.registration.state))}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Sidebar({ view, onView, accounts }: SidebarProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <aside className="sidebar">
      <div className="brand">
        <h1>{t('app.title')}</h1>
        <p>{t('app.tagline')}</p>
      </div>
      <nav className="nav" aria-label={t('app.title')}>
        {NAV.map((item) => (
          <button key={item.id} type="button" className={cx('nav-item')} aria-current={item.id === view ? 'page' : undefined} onClick={() => onView(item.id)}>
            <Icon name={item.icon} />
            <span>{t(item.labelKey)}</span>
          </button>
        ))}
      </nav>
      <AccountStatus accounts={accounts} />
    </aside>
  );
}
