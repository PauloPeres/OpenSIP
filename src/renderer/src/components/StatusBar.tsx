import type { AccountView } from '../../../shared/api';
import { useTranslation } from '../i18n/TranslatorProvider';
import type { CallView } from '../../../shared/api';
import { endReasonKey, isSetupTimeout } from '../state/callProgress';
import { RegistrationNote } from './RegistrationNote';
import { isDisplaced } from '../state/accountState';
import { DisplacedNote } from './SharingNote';
import { Breakable } from './ui/Breakable';
import { cx } from './ui/cx';

function isNoteworthy(view: AccountView): boolean {
  return view.registration.state === 'registering' || view.registration.state === 'failed' || isDisplaced(view);
}

function RegistrationRows({ accounts }: { readonly accounts: readonly AccountView[] }): JSX.Element {
  return (
    <>
      {accounts.filter(isNoteworthy).map((view) => (
        <p key={view.account.id} className="statusbar-row" role={view.registration.state === 'registering' ? 'status' : 'alert'}>
          <strong>{view.account.displayName}</strong>
          {isDisplaced(view) ? <DisplacedNote withHint /> : <RegistrationNote registration={view.registration} />}
        </p>
      ))}
    </>
  );
}

interface BarProps {
  readonly accounts: readonly AccountView[];
  readonly calls: readonly CallView[];
}

const ENDED = 'calls.progress.ended'; // i18n-exempt: translation key

function EndedRows({ calls }: { readonly calls: readonly CallView[] }): JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      {calls.map((view) => (
        <p key={view.call.id} className="statusbar-row" role={isSetupTimeout(view) ? 'alert' : 'status'}>
          <strong><Breakable text={view.call.remoteIdentity} titled /></strong>
          <span className={cx('progress', isSetupTimeout(view) && 'progress-bad')}>{t(endReasonKey(view) ?? ENDED)}</span>
        </p>
      ))}
    </>
  );
}

/** What the app is waiting on or has just failed at, visible from every view. */
export function StatusBar({ accounts, calls }: BarProps): JSX.Element | null {
  const ended = calls.filter((c) => c.call.state === 'ended' && endReasonKey(c) !== null);
  if (!accounts.some(isNoteworthy) && ended.length === 0) return null;
  return (
    <div className="statusbar">
      <RegistrationRows accounts={accounts} />
      <EndedRows calls={ended} />
    </div>
  );
}
