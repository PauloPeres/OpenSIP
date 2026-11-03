import { SUPPORTED_LOCALES } from '@core/i18n';
import type { Locale } from '@core/i18n';
import type { UpdateStatus } from '../../../shared/api';
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
  return (
    <div className="field">
      <label htmlFor="language">{t('settings.language')}</label>
      <select
        id="language"
        value={locale}
        onChange={(event) => void setLocale(event.target.value as Locale)}
      >
        {SUPPORTED_LOCALES.map((code) => (
          <option key={code} value={code}>
            {t(LOCALE_KEYS[code])}
          </option>
        ))}
      </select>
    </div>
  );
}

export function SettingsPanel({ update }: { readonly update: UpdateStatus }): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="card form">
      <LanguageSelect />
      <p className="muted" role="status">
        {updateText(t, update)}
      </p>
    </div>
  );
}
