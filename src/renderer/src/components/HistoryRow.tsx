import { callDuration } from '@core/history';
import type { CallRecord } from '@core/history';
import { useTranslation } from '../i18n/TranslatorProvider';
import { formatDuration } from '../state/format';
import { fullLabel, timeLabel } from '../state/historyTime';
import { Badge } from './ui/Badge';
import { Breakable } from './ui/Breakable';
import { Button } from './ui/Button';
import { cx } from './ui/cx';
import { Icon } from './ui/Icon';

export interface HistoryRowProps {
  readonly record: CallRecord;
  /** Display name of the account the call used; absent once that account was deleted. */
  readonly accountName: string | undefined;
  readonly dialable: boolean;
  readonly onRedial: (record: CallRecord) => void;
  readonly onRemove: (id: string) => void;
}

function Direction({ record }: { readonly record: CallRecord }): JSX.Element {
  const { t } = useTranslation();
  const inbound = record.direction === 'inbound';
  return (
    <span className="history-dir">
      <Icon name={inbound ? 'arrowIn' : 'arrowOut'} />
      <span className="sr-only">{t(`calls.direction.${record.direction}`)}</span>
    </span>
  );
}

function Meta({ record, accountName }: Pick<HistoryRowProps, 'record' | 'accountName'>): JSX.Element {
  const { t, tw, locale } = useTranslation();
  return (
    <span className="history-meta">
      <time dateTime={new Date(record.endedAt).toISOString()} title={fullLabel(locale, record.endedAt)}>
        {t('history.at', { time: timeLabel(locale, record.endedAt) })}
      </time>
      {accountName === undefined ? null : <span>{t('history.via', { account: accountName })}</span>}
      {record.endReasonKey === undefined ? null : <span>{tw(record.endReasonKey)}</span>}
    </span>
  );
}

function Result({ record }: { readonly record: CallRecord }): JSX.Element {
  const { t } = useTranslation();
  const duration = callDuration(record);
  return (
    <span className="history-result">
      <Badge tone={record.outcome} label={t(`history.outcome.${record.outcome}`)} />
      {duration === undefined ? null : (
        <span className="history-duration">{t('history.duration', { duration: formatDuration(duration) })}</span>
      )}
    </span>
  );
}

function RedialButton({ record, accountName, dialable, onRedial }: Omit<HistoryRowProps, 'onRemove'>): JSX.Element {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="history-main"
      disabled={!dialable}
      title={t('history.redial')}
      aria-label={`${t('history.redial')}: ${record.remoteIdentity}`}
      onClick={() => onRedial(record)}
    >
      <Direction record={record} />
      <span className="history-id">
        <Breakable text={record.remoteIdentity} className="history-who" />
        <Meta record={record} accountName={accountName} />
      </span>
      <Result record={record} />
    </button>
  );
}

/** The whole row redials; removal is its own button beside it, never nested inside. */
export function HistoryRow(props: HistoryRowProps): JSX.Element {
  const { t } = useTranslation();
  const { record, dialable, onRemove } = props;
  return (
    <li className={cx('history-row', `history-${record.outcome}`)}>
      <RedialButton {...props} />
      <Button iconOnly icon="trash" variant="ghost" label={t('history.remove')} onClick={() => onRemove(record.id)} />
      {dialable ? null : <p className="history-note">{t('history.noRedial')}</p>}
    </li>
  );
}
