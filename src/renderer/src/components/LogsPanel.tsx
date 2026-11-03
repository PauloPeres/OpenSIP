import { useState } from 'react';
import type { AppSnapshot } from '../../../shared/api';
import { useTranslation } from '../i18n/TranslatorProvider';
import type { TranslationApi } from '../i18n/TranslatorProvider';
import { formatClock } from '../state/format';
import type { AppActions } from '../state/useAppState';
import { LEVELS, filterLogs, useFlash, useStickyScroll } from '../state/useLogView';
import type { LogEntry, LogLevel } from '../state/useLogView';
import { ErrorBoundary } from './ErrorBoundary';
import { LogRow } from './LogRow';
import { Button } from './ui/Button';
import { SelectField, Switch } from './ui/Field';
import { Segmented } from './ui/Segmented';

interface LogsPanelProps {
  readonly snapshot: AppSnapshot;
  readonly actions: AppActions;
}

interface LogControls {
  readonly accountId: string;
  readonly minLevel: LogLevel;
  readonly setAccountId: (id: string) => void;
  readonly setMinLevel: (level: LogLevel) => void;
  readonly entries: readonly LogEntry[];
  readonly clear: () => void;
}

function toPlainText(entries: readonly LogEntry[], { tw }: TranslationApi): string {
  return entries
    .map((e) => `${formatClock(e.at)} ${tw(`logs.level.${e.level}`)} ${tw(e.messageKey, e.params)}${e.raw ? `\n${e.raw}` : ''}`)
    .join('\n');
}

function CopyButton({ entries }: { readonly entries: readonly LogEntry[] }): JSX.Element {
  const api = useTranslation();
  const { t } = api;
  const [copied, flash] = useFlash(1600);
  const copy = (): void => {
    navigator.clipboard.writeText(toPlainText(entries, api)).then(flash).catch(() => undefined);
  };
  return <Button label={copied ? t('logs.copied') : t('logs.copy')} onClick={copy} disabled={entries.length === 0} />;
}

interface FiltersProps {
  readonly accounts: AppSnapshot['accounts'];
  readonly accountId: string;
  readonly minLevel: LogLevel;
  readonly onAccount: (id: string) => void;
  readonly onLevel: (level: LogLevel) => void;
}

function Filters({ accounts, accountId, minLevel, onAccount, onLevel }: FiltersProps): JSX.Element {
  const { t } = useTranslation();
  const all = { value: '', label: t('logs.filter.all') };
  const options = [all, ...accounts.map((a) => ({ value: a.account.id, label: a.account.displayName }))];
  const levels = LEVELS.map((level) => ({ value: level, label: t(`logs.level.${level}`) }));
  return (
    <div className="log-filters">
      <SelectField id="log-account" label={t('logs.filter.account')} value={accountId} options={options} onChange={onAccount} />
      <Segmented label={t('logs.filter.level')} value={minLevel} options={levels} onChange={(v) => onLevel(v as LogLevel)} />
    </div>
  );
}

function LogList({ entries, snapshot }: { readonly entries: readonly LogEntry[]; readonly snapshot: AppSnapshot }): JSX.Element {
  const { t, tw } = useTranslation();
  const scroll = useStickyScroll(entries[entries.length - 1]?.id);
  const names = new Map(snapshot.accounts.map((a) => [a.account.id, a.account.displayName]));
  return (
    <div className="log-scroll" ref={scroll.ref} onScroll={scroll.onScroll} tabIndex={0} role="log" aria-label={t('logs.title')}>
      {entries.length === 0 ? <p className="muted pad">{t('logs.empty')}</p> : null}
      <ul className="log-list">
        {entries.map((entry) => (
          <ErrorBoundary key={entry.id} as="li">
            <LogRow entry={entry} accountName={names.get(entry.accountId ?? '') ?? ''} t={t} tw={tw} />
          </ErrorBoundary>
        ))}
      </ul>
    </div>
  );
}

function useLogControls(snapshot: AppSnapshot, actions: AppActions): LogControls {
  const [accountId, setAccountId] = useState('');
  const [minLevel, setMinLevel] = useState<LogLevel>('debug');
  const [clearedBefore, setClearedBefore] = useState(0);
  const entries = filterLogs(snapshot.logs, { accountId, minLevel }, clearedBefore);
  const clear = (): void => {
    setClearedBefore(snapshot.logs[snapshot.logs.length - 1]?.id ?? 0);
    void actions.clearLogs();
  };
  return { accountId, minLevel, setAccountId, setMinLevel, entries, clear };
}

export function LogsPanel({ snapshot, actions }: LogsPanelProps): JSX.Element {
  const { t } = useTranslation();
  const c = useLogControls(snapshot, actions);
  return (
    <section className="panel logs" aria-labelledby="logs-title">
      <h2 id="logs-title" className="panel-title">{t('logs.title')}</h2>
      <Switch id="debug-logging" label={t('logs.debug')} hint={t('logs.debugHint')} checked={snapshot.debugLogging} onChange={(on) => void actions.setDebug(on)} />
      <div className="log-toolbar">
        <Filters accounts={snapshot.accounts} accountId={c.accountId} minLevel={c.minLevel} onAccount={c.setAccountId} onLevel={c.setMinLevel} />
        <div className="log-actions">
          <CopyButton entries={c.entries} />
          <Button label={t('logs.clear')} variant="ghost" onClick={c.clear} />
        </div>
      </div>
      <LogList entries={c.entries} snapshot={snapshot} />
    </section>
  );
}
