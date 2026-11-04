import { useState } from 'react';
import { countMissed, filterHistory, redialTarget } from '@core/history';
import type { CallRecord, HistoryFilter } from '@core/history';
import type { AppSnapshot } from '../../../shared/api';
import { useTranslation } from '../i18n/TranslatorProvider';
import { dayLabel, groupByDay } from '../state/historyTime';
import type { DayGroup } from '../state/historyTime';
import type { AppActions } from '../state/useAppState';
import { useRedial } from '../state/useRedial';
import { HistoryRow } from './HistoryRow';
import { Button } from './ui/Button';
import { Icon } from './ui/Icon';
import { Segmented } from './ui/Segmented';

interface HistoryPanelProps {
  readonly snapshot: AppSnapshot;
  readonly actions: AppActions;
  readonly onDialed: (callId: string) => void;
}

interface ToolbarProps {
  readonly filter: HistoryFilter;
  readonly missed: number;
  readonly empty: boolean;
  readonly onFilter: (filter: HistoryFilter) => void;
  readonly onClear: () => void;
}

function Toolbar({ filter, missed, empty, onFilter, onClear }: ToolbarProps): JSX.Element {
  const { t } = useTranslation();
  const missedLabel = missed === 0 ? t('history.filter.missed') : `${t('history.filter.missed')} (${missed})`;
  const options = [
    { value: 'all', label: t('history.filter.all') },
    { value: 'missed', label: missedLabel }
  ];
  return (
    <div className="history-toolbar">
      <Segmented label={t('history.title')} value={filter} options={options} onChange={(v) => onFilter(v as HistoryFilter)} />
      <Button label={t('history.clear')} variant="ghost" icon="trash" onClick={onClear} disabled={empty} />
    </div>
  );
}

function ConfirmClear({ onConfirm, onCancel }: { readonly onConfirm: () => void; readonly onCancel: () => void }): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="history-confirm" role="alertdialog" aria-labelledby="history-confirm-text">
      <p id="history-confirm-text">{t('history.clearConfirm')}</p>
      <div className="history-confirm-actions">
        <Button label={t('common.cancel')} onClick={onCancel} />
        <Button label={t('history.clear')} variant="danger" onClick={onConfirm} />
      </div>
    </div>
  );
}

interface GroupsProps {
  readonly groups: readonly DayGroup[];
  readonly names: ReadonlyMap<string, string>;
  readonly onRedial: (record: CallRecord) => void;
  readonly onRemove: (id: string) => void;
}

function DayView({ group, names, onRedial, onRemove }: Omit<GroupsProps, 'groups'> & { readonly group: DayGroup }): JSX.Element {
  const { locale } = useTranslation();
  return (
    <section className="history-day">
      <h3 className="history-day-title">{dayLabel(locale, group.day, Date.now())}</h3>
      <ul className="history-list">
        {group.records.map((record) => (
          <HistoryRow
            key={record.id}
            record={record}
            accountName={names.get(record.accountId)}
            dialable={redialTarget(record.remoteIdentity) !== undefined}
            onRedial={onRedial}
            onRemove={onRemove}
          />
        ))}
      </ul>
    </section>
  );
}

function Groups({ groups, ...rest }: GroupsProps): JSX.Element {
  return (
    <div className="history-scroll">
      {groups.map((group) => (
        <DayView key={group.day} group={group} {...rest} />
      ))}
    </div>
  );
}

function Empty(): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="empty">
      <Icon name="clock" />
      <p>{t('history.empty')}</p>
    </div>
  );
}

interface HistoryModel {
  readonly filter: HistoryFilter;
  readonly setFilter: (filter: HistoryFilter) => void;
  readonly confirming: boolean;
  readonly setConfirming: (on: boolean) => void;
  readonly errorKey: string | null;
  readonly redial: (record: CallRecord) => void;
  readonly clear: () => void;
}

function useHistoryModel({ snapshot, actions, onDialed }: HistoryPanelProps): HistoryModel {
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [confirming, setConfirming] = useState(false);
  const { redial, errorKey } = useRedial({ accounts: snapshot.accounts, calls: snapshot.calls, dial: actions.dial, onDialed });
  const clear = (): void => {
    setConfirming(false);
    void actions.clearHistory();
  };
  return { filter, setFilter, confirming, setConfirming, errorKey, redial, clear };
}

export function HistoryPanel(props: HistoryPanelProps): JSX.Element {
  const { t, tw } = useTranslation();
  const { snapshot, actions } = props;
  const m = useHistoryModel(props);
  const shown = filterHistory(snapshot.history, m.filter);
  const names = new Map(snapshot.accounts.map((a) => [a.account.id, a.account.displayName]));
  const remove = (id: string): void => void actions.removeHistoryEntry(id);
  return (
    <section className="panel history" aria-labelledby="history-title">
      <h2 id="history-title" className="panel-title">{t('history.title')}</h2>
      <Toolbar filter={m.filter} missed={countMissed(snapshot.history)} empty={snapshot.history.length === 0} onFilter={m.setFilter} onClear={() => m.setConfirming(true)} />
      {m.confirming ? <ConfirmClear onConfirm={m.clear} onCancel={() => m.setConfirming(false)} /> : null}
      {m.errorKey === null ? null : <p className="field-error" role="alert">{tw(m.errorKey)}</p>}
      {shown.length === 0 ? <Empty /> : <Groups groups={groupByDay(shown)} names={names} onRedial={m.redial} onRemove={remove} />}
    </section>
  );
}
