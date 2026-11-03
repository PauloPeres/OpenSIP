import { useState } from 'react';
import type { SipAccount } from '@core/sip';
import { AccountForm } from './components/AccountForm';
import { AccountList } from './components/AccountList';
import { Dialer } from './components/Dialer';
import { IncomingCalls } from './components/IncomingCalls';
import { LinesPanel } from './components/LinesPanel';
import { LogsPanel } from './components/LogsPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { Sidebar } from './components/Sidebar';
import type { ViewId } from './components/Sidebar';
import { Button } from './components/ui/Button';
import { useTranslation } from './i18n/TranslatorProvider';
import { useAnnouncement } from './state/useAnnouncement';
import { useAppState } from './state/useAppState';
import type { AppState } from './state/useAppState';
import { useLines } from './state/useLines';
import type { LinesModel } from './state/useLines';
import { useNow } from './state/useNow';

type Editing = SipAccount | 'new' | null;

function AccountsView({ state }: { readonly state: AppState }): JSX.Element {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<Editing>(null);
  const { actions, snapshot } = state;
  if (editing !== null) {
    const initial = editing === 'new' ? undefined : editing;
    return <AccountForm {...(initial ? { initial } : {})} onSave={actions.saveAccount} onDone={() => setEditing(null)} />;
  }
  return (
    <section className="panel" aria-labelledby="accounts-title">
      <div className="panel-head">
        <h2 id="accounts-title" className="panel-title">{t('accounts.title')}</h2>
        <Button variant="primary" label={t('accounts.add')} onClick={() => setEditing('new')} />
      </div>
      <AccountList accounts={snapshot.accounts} onEdit={setEditing} onRemove={(a) => void actions.deleteAccount(a.id)} />
    </section>
  );
}

function PhoneView({ state, model, now }: { readonly state: AppState; readonly model: LinesModel; readonly now: number }): JSX.Element {
  const { snapshot, actions } = state;
  return (
    <div className="phone">
      <LinesPanel model={model} env={{ accounts: snapshot.accounts, actions, now }} />
      <Dialer accounts={snapshot.accounts} dial={actions.dial} onDialed={model.focus} />
    </div>
  );
}

function ViewContent({ view, state, model, now }: { readonly view: ViewId; readonly state: AppState; readonly model: LinesModel; readonly now: number }): JSX.Element {
  if (view === 'accounts') return <AccountsView state={state} />;
  if (view === 'logs') return <LogsPanel snapshot={state.snapshot} actions={state.actions} />;
  if (view === 'settings') return <SettingsPanel update={state.update} />;
  return <PhoneView state={state} model={model} now={now} />;
}

interface CallFlow {
  readonly model: LinesModel;
  readonly now: number;
  readonly announcement: string;
  readonly answer: (callId: string) => void;
}

function useCallFlow(state: AppState, showCalls: () => void): CallFlow {
  const model = useLines(state.snapshot.calls);
  const now = useNow(model.lines.some((l) => l.view.connectedAt !== undefined));
  const announcement = useAnnouncement(model.lines);
  const answer = (id: string): void => {
    void state.actions.answer(id);
    model.focus(id);
    showCalls();
  };
  return { model, now, announcement, answer };
}

export function App(): JSX.Element {
  const { t } = useTranslation();
  const state = useAppState();
  const [view, setView] = useState<ViewId>('calls');
  const flow = useCallFlow(state, () => setView('calls'));
  const { accounts } = state.snapshot;
  return (
    <div className="shell">
      <Sidebar view={view} onView={setView} accounts={accounts} />
      <div className="main">
        <IncomingCalls lines={flow.model.lines} accounts={accounts} onAnswer={flow.answer} onReject={(id) => void state.actions.reject(id)} />
        {state.failed ? <p className="notice" role="alert">{t('error.unexpected')}</p> : null}
        <main className="view">
          <ViewContent view={view} state={state} model={flow.model} now={flow.now} />
        </main>
      </div>
      <div className="sr-only" role="status" aria-live="polite">{flow.announcement}</div>
    </div>
  );
}
