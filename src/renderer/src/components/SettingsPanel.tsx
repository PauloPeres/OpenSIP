import { SUPPORTED_LOCALES } from '@core/i18n';
import type { Locale } from '@core/i18n';
import type { UpdateStatus } from '../../../shared/api';
import { PermissionsSection } from './PermissionsSection';
import { SelectField, Switch } from './ui/Field';
import { usePermissions } from '../state/permissions';
import { useTranslation } from '../i18n/TranslatorProvider';
import type { TranslationApi } from '../i18n/TranslatorProvider';

const LOCALE_KEYS: Readonly<Record<Locale, string>> = {
  en: 'settings.language.en',
  'pt-BR': 'settings.language.ptBR' // i18n-exempt: translation key
};

function updateText(t: TranslationApi['t'], status: UpdateStatus): string {
  switch (status.kind) {
    case 'checking':
      return t('settings.updates.checking');
    case 'available':
      return t('settings.updates.available', { version: status.version });
    case 'upToDate': // i18n-exempt: discriminant
      return t('settings.updates.upToDate');
    case 'error':
      return t('settings.updates.error');
    default:
      return '';
  }
}

function LanguageSelect(): JSX.Element {
  const { t, locale, setLocale } = useTranslation();
  const options = SUPPORTED_LOCALES.map((code) => ({ value: code, label: t(LOCALE_KEYS[code]) }));
  return (
    <SelectField id="language" label={t('settings.language')} value={locale} options={options} onChange={(value) => void setLocale(value as Locale)} />
  );
}

export interface RingtonePref {
  readonly enabled: boolean;
  readonly set: (next: boolean) => void;
}

export function SettingsPanel({ update, ringtone }: { readonly update: UpdateStatus; readonly ringtone: RingtonePref }): JSX.Element {
  const { t } = useTranslation();
  const permissions = usePermissions();
  return (
    <div className="panel form">
      <LanguageSelect />
      <Switch id="ringtone" label={t('settings.ringtone')} hint={t('settings.ringtone.hint')} checked={ringtone.enabled} onChange={ringtone.set} />
      <PermissionsSection model={permissions} />
      <p className="muted" role="status">
        {updateText(t, update)}
      </p>
    </div>
  );
}
