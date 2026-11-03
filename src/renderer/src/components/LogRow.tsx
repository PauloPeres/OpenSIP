import { memo } from 'react';
import type { TranslationApi } from '../i18n/TranslatorProvider';
import { formatClock } from '../state/format';
import type { LogEntry } from '../state/useLogView';
import { cx } from './ui/cx';

interface LogRowProps {
  readonly entry: LogEntry;
  readonly accountName: string;
  readonly t: TranslationApi['t'];
}

function RawBlock({ raw, label }: { readonly raw: string; readonly label: string }): JSX.Element {
  return (
    <details className="log-raw">
      <summary>{label}</summary>
      <pre>{raw}</pre>
    </details>
  );
}

function LogRowView({ entry, accountName, t }: LogRowProps): JSX.Element {
  const loud = entry.level === 'warn' || entry.level === 'error';
  return (
    <li className={cx('log-row', `log-${entry.level}`)}>
      <time className="log-time" dateTime={new Date(entry.at).toISOString()}>{formatClock(entry.at)}</time>
      <span className={loud ? 'log-level' : 'sr-only'}>{t(`logs.level.${entry.level}`)}</span>
      <span className="log-message">
        {t(entry.messageKey, entry.params)}
        {accountName === '' ? null : <span className="log-account">{accountName}</span>}
        {entry.raw === undefined ? null : <RawBlock raw={entry.raw} label={t('logs.raw')} />}
      </span>
    </li>
  );
}

/** Entries are immutable per id, so a row only re-renders when its own data or the locale changes. */
export const LogRow = memo(
  LogRowView,
  (prev, next) => prev.entry.id === next.entry.id && prev.accountName === next.accountName && prev.t === next.t
);
