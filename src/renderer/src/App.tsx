import { useState } from 'react';
import type { SipAccount } from '@core/sip';
import { AccountForm } from './components/AccountForm';
import { AccountList } from './components/AccountList';
import { Dialer } from './components/Dialer';
import { IncomingCalls } from './components/IncomingCalls';
import { LinesPanel } from './components/LinesPanel';
import { LogsPanel } from './components/LogsPanel';
import { SettingsPanel } from './components/SettingsPanel';
import type { RingtonePref } from './components/SettingsPanel';
import { Onboarding } from './components/Onboarding';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import type { ViewId } from './components/Sidebar';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Button } from './components/ui/Button';
import { useTranslation } from './i18n/TranslatorProvider';
import { useAnnouncement } from './state/useAnnouncement';
import { useAppState } from './state/useAppState';
import type { AppState } from './state/useAppState';
import { useLines } from './state/useLines';
import type { LinesModel } from './state/useLines';
import { useIncomingNotification } from './state/useIncomingNotification';
import { useNow } from './state/useNow';
import { useSetupClock } from './state/useSetupClock';
import { isPending } from './state/callProgress';
import { useOnboarding } from './state/useOnboarding';
import { useRingtone } from './state/useRingtone';
import { useStoredFlag } from './state/storage';

type Editing = SipAccount | 'new' | null;

/** The switch shows the snapshot; a refused or failed request only adds a note beside that account. */
function useToggle(actions: AppState['actions']): { readonly refusedId: string | null; readonly toggle: (a: SipAccount, enabled: boolean) => void } {
  const [refusedId, setRefusedId] = useState<string | null>(null);
  const toggle = (account: SipAccount, enabled: boolean): void => {
    setRefusedId(null);
    actions.setAccountEnabled(account.id, enabled).catch(() => setRefusedId(account.id));
  };
  return { refusedId, toggle };
}

function AccountsView({ state }: { readonly state: AppState }): JSX.Element {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<Editing>(null);
  const { refusedId, toggle } = useToggle(state.actions);
  const { actions, snapshot } = state;
  if (editing !== null) {
    const initial = editing === 'new' ? undefined : editing;
    return <AccountForm {...(initial ? { initial } : {})} onSave={actions.saveAccount} onDone={() => setEditing(null)} />;
  }
  return (
    <section className="panel accounts" aria-labelledby="accounts-title">
      <div className="panel-head">
        <h2 id="accounts-title" className="panel-title">{t('accounts.title')}</h2>
        <Button variant="primary" label={t('accounts.add')} onClick={() => setEditing('new')} />
      </div>
      <AccountList accounts={snapshot.accounts} calls={snapshot.calls} onEdit={setEditing} onRemove={(a) => void actions.deleteAccount(a.id)} onToggle={toggle} refusedId={refusedId} />
    </section>
  );
}

function PhoneView({ state, model, now, setupStarts }: Omit<ViewProps, 'view' | 'ringtone'>): JSX.Element {
  const { snapshot, actions } = state;
  return (
    <div className="phone">
      <ErrorBoundary>
        <LinesPanel model={model} env={{ accounts: snapshot.accounts, actions, now, setupStarts }} />
      </ErrorBoundary>
      <ErrorBoundary>
        <Dialer accounts={snapshot.accounts} calls={snapshot.calls} dial={actions.dial} onDialed={model.focus} />
      </ErrorBoundary>
    </div>
  );
}

interface ViewProps {
  readonly view: ViewId;
  readonly state: AppState;
  readonly model: LinesModel;
  readonly now: number;
  readonly setupStarts: ReadonlyMap<string, number>;
  readonly ringtone: RingtonePref;
}

function ViewContent({ view, state, model, now, setupStarts, ringtone }: ViewProps): JSX.Element {
  if (view === 'accounts') return <AccountsView state={state} />;
  if (view === 'logs') return <LogsPanel snapshot={state.snapshot} actions={state.actions} />;
  if (view === 'settings') return <SettingsPanel update={state.update} ringtone={ringtone} />;
  return <PhoneView state={state} model={model} now={now} setupStarts={setupStarts} />;
}

interface CallFlow {
  readonly model: LinesModel;
  readonly now: number;
  readonly setupStarts: ReadonlyMap<string, number>;
  readonly announcement: string;
  readonly ringtone: RingtonePref;
  readonly answer: (callId: string) => void;
}

function useCallFlow(state: AppState, showCalls: () => void): CallFlow {
  const model = useLines(state.snapshot.calls);
  const now = useNow(model.lines.some((l) => l.view.connectedAt !== undefined || isPending(l.view)));
  const setupStarts = useSetupClock(model.lines);
  const announcement = useAnnouncement(model.lines);
  const [enabled, setEnabled] = useStoredFlag('opensip.ringtone', true);
  useRingtone(model.lines, enabled);
  useIncomingNotification(model.lines, state.snapshot.accounts);
  const answer = (id: string): void => {
    void state.actions.answer(id);
    model.focus(id);
    showCalls();
  };
  return { model, now, setupStarts, announcement, ringtone: { enabled, set: setEnabled }, answer };
}

interface AlertsProps {
  readonly state: AppState;
  readonly flow: CallFlow;
}

/** Each wire-driven strip has its own boundary, so none of them can take the call controls down with it. */
function Alerts({ state, flow }: AlertsProps): JSX.Element {
  const { accounts, calls } = state.snapshot;
  return (
    <>
      <ErrorBoundary>
        <IncomingCalls lines={flow.model.lines} accounts={accounts} onAnswer={flow.answer} onReject={(id) => void state.actions.reject(id)} />
      </ErrorBoundary>
      <ErrorBoundary>
        <StatusBar accounts={accounts} calls={calls} />
      </ErrorBoundary>
    </>
  );
}

function Workspace({ state }: { readonly state: AppState }): JSX.Element {
  const { t } = useTranslation();
  const [view, setView] = useState<ViewId>('calls');
  const flow = useCallFlow(state, () => setView('calls'));
  return (
    <div className="shell">
      <Sidebar view={view} onView={setView} accounts={state.snapshot.accounts} />
      <div className="main">
        <Alerts state={state} flow={flow} />
        {state.failed ? <p className="notice" role="alert">{t('error.unexpected')}</p> : null}
        <main className="view">
          <ErrorBoundary key={view}>
            <ViewContent view={view} state={state} model={flow.model} now={flow.now} setupStarts={flow.setupStarts} ringtone={flow.ringtone} />
          </ErrorBoundary>
        </main>
      </div>
      <div className="sr-only" role="status" aria-live="polite">{flow.announcement}</div>
    </div>
  );
}

export function App(): JSX.Element {
  const state = useAppState();
  const onboarding = useOnboarding();
  if (!onboarding.done) return <Onboarding onSave={state.actions.saveAccount} onFinish={onboarding.finish} />;
  return <Workspace state={state} />;
}
