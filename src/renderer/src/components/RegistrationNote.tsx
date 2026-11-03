import type { RegistrationSnapshot } from '@core/sip';
import { useTranslation } from '../i18n/TranslatorProvider';
import { textOrFallback } from '../state/format';

/** Says what registration is doing: waiting while it registers, the reason when it fails. */
interface NoteProps {
  readonly registration: RegistrationSnapshot;
  /** Where the state is already named (a badge, a label), only add the failure reason. */
  readonly failuresOnly?: boolean;
}

export function RegistrationNote({ registration, failuresOnly = false }: NoteProps): JSX.Element | null {
  const { t } = useTranslation();
  if (registration.state === 'registering' && !failuresOnly) {
    return (
      <span className="progress progress-pending">
        <i className="spinner" aria-hidden="true" />
        {t('registration.state.registering')}
      </span>
    );
  }
  if (registration.state !== 'failed') return null;
  const reason = registration.failureReason ?? 'registration.state.failed';
  return <span className="progress progress-bad">{textOrFallback(t, reason, 'registration.state.failed')}</span>;
}
