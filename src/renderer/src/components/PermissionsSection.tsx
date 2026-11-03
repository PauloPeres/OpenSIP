import { useTranslation } from '../i18n/TranslatorProvider';
import type { PermState, PermissionsModel } from '../state/permissions';
import { DeniedHint, PermBadge } from './PermissionStatus';
import { Button } from './ui/Button';

interface RowProps {
  readonly label: string;
  readonly state: PermState;
  readonly onAllow: () => Promise<void>;
  readonly settings?: boolean;
}

function PermissionRow({ label, state, onAllow, settings = false }: RowProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <li className="perm-row">
      <span className="perm-name">{label}</span>
      <PermBadge state={state} />
      {state === 'pending' ? <Button label={t('onboarding.allow')} onClick={() => void onAllow()} /> : null}
      <DeniedHint state={state} settings={settings} />
    </li>
  );
}

export function PermissionsSection({ model }: { readonly model: PermissionsModel }): JSX.Element {
  const { t } = useTranslation();
  return (
    <section className="perm" aria-labelledby="perm-title">
      <div className="panel-head">
        <h2 id="perm-title" className="panel-title">{t('permissions.title')}</h2>
        <Button label={t('permissions.recheck')} onClick={model.recheck} />
      </div>
      <ul className="perm-list">
        <PermissionRow label={t('permissions.microphone')} state={model.microphone} onAllow={model.askMicrophone} settings />
        <PermissionRow label={t('permissions.notifications')} state={model.notifications} onAllow={model.askNotifications} />
      </ul>
    </section>
  );
}
