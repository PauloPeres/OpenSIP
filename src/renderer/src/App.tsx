import { useState } from 'react';
import type { SipAccount } from '@core/sip';
import { AccountForm } from './components/AccountForm';
import { AccountList } from './components/AccountList';
import { CallPanel } from './components/CallPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { ActionButton } from './components/StatusBadge';
import { useTranslation } from './i18n/TranslatorProvider';
import { useAppState } from './state/useAppState';
import type { AppState } from './state/useAppState';

type TabId = 'accounts' | 'calls' | 'settings';

const TABS: readonly { readonly id: TabId; readonly labelKey: string }[] = [
  { id: 'accounts', labelKey: 'nav.accounts' },
  { id: 'calls', labelKey: 'nav.calls' },
  { id: 'settings', labelKey: 'nav.settings' }
];

type Editing = SipAccount | 'new' | null;

function AccountsTab({ state }: { readonly state: AppState }): JSX.Element {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<Editing>(null);
  const { actions, snapshot } = state;
  if (editing !== null) {
    const initial = editing === 'new' ? undefined : editing;
    return <AccountForm {...(initial ? { initial } : {})} onSave={actions.saveAccount} onDone={() => setEditing(null)} />;
  }
  return (
    <>
      <ActionButton variant="primary" label={t('accounts.add')} onClick={() => setEditing('new')} />
      <AccountList
        accounts={snapshot.accounts}
        onEdit={setEditing}
        onRemove={(account) => void actions.deleteAccount(account.id)}
      />
    </>
  );
}

function TabBar({ active, onSelect }: { readonly active: TabId; readonly onSelect: (id: TabId) => void }): JSX.Element {
  const { t } = useTranslation();
  return (
    <nav className="tabs" role="tablist">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === active}
          className={tab.id === active ? 'tab tab-active' : 'tab'}
          onClick={() => onSelect(tab.id)}
        >
          {t(tab.labelKey)}
        </button>
      ))}
    </nav>
  );
}

function TabContent({ tab, state }: { readonly tab: TabId; readonly state: AppState }): JSX.Element {
  if (tab === 'calls') return <CallPanel calls={state.snapshot.calls} actions={state.actions} />;
  if (tab === 'settings') return <SettingsPanel update={state.update} />;
  return <AccountsTab state={state} />;
}

export function App(): JSX.Element {
  const { t } = useTranslation();
  const state = useAppState();
  const [tab, setTab] = useState<TabId>('accounts');
  return (
    <div className="app">
      <header className="header">
        <h1>{t('app.title')}</h1>
        <span className="muted">{t('app.tagline')}</span>
      </header>
      <TabBar active={tab} onSelect={setTab} />
      {state.failed ? <p role="alert">{t('error.unexpected')}</p> : null}
      <main className="content" role="tabpanel">
        <TabContent tab={tab} state={state} />
      </main>
    </div>
  );
}
