import { useTranslation } from '../i18n/TranslatorProvider';
import type { PermState } from '../state/permissions';
import { getApi } from '../state/api';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';

const LABEL_KEY: Readonly<Record<PermState, string>> = {
  pending: 'onboarding.pending',
  granted: 'onboarding.granted',
  denied: 'onboarding.denied'
};

export function PermBadge({ state }: { readonly state: PermState }): JSX.Element {
  const { t } = useTranslation();
  return <Badge tone={state} label={t(LABEL_KEY[state])} />;
}

/** macOS will not prompt again after a denial, so the way out is spelled out here and offered by `SettingsAction`. */
export function DeniedHint({ state }: { readonly state: PermState }): JSX.Element | null {
  const { t } = useTranslation();
  return state === 'denied' ? <p className="hint">{t('onboarding.deniedHint')}</p> : null;
}

/** Opens the OS pane after a denial; only the microphone pane is wired, so only it asks for this. */
export function SettingsAction({ state, settings }: { readonly state: PermState; readonly settings: boolean }): JSX.Element | null {
  const { t } = useTranslation();
  if (state !== 'denied' || !settings) return null;
  return <Button label={t('onboarding.reopen')} onClick={() => void getApi().openSystemSettings()} />;
}
