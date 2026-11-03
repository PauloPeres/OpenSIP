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

/** macOS will not prompt again after a denial, so the way out is spelled out and one click away. */
/** `settings` adds the button that opens the OS pane; only the microphone pane is wired, so only it asks for it. */
export function DeniedHint({ state, settings = false }: { readonly state: PermState; readonly settings?: boolean }): JSX.Element | null {
  const { t } = useTranslation();
  if (state !== 'denied') return null;
  return (
    <>
      <p className="hint">{t('onboarding.deniedHint')}</p>
      {settings ? <Button label={t('onboarding.reopen')} onClick={() => void getApi().openSystemSettings()} /> : null}
    </>
  );
}
