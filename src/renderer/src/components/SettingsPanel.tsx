import { SUPPORTED_LOCALES } from '@core/i18n';
import type { Locale } from '@core/i18n';
import type { UpdateStatus } from '../../../shared/api';
import { PermissionsSection } from './PermissionsSection';
import { UserAgentField } from './UserAgentField';
import type { UserAgentPref } from './UserAgentField';
import { SelectField, Switch } from './ui/Field';
import { Segmented } from './ui/Segmented';
import { THEMES, isTheme, useTheme } from '../state/theme';
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

function ThemeSelect(): JSX.Element {
  const { t } = useTranslation();
  const [theme, setTheme] = useTheme();
  const options = THEMES.map((choice) => ({ value: choice, label: t(`settings.theme.${choice}`) }));
  return (
    <div className="field">
      <span className="field-title">{t('settings.theme')}</span>
      <Segmented label={t('settings.theme')} value={theme} options={options} onChange={(v) => isTheme(v) && setTheme(v)} />
      <span className="hint">{t('settings.theme.hint')}</span>
    </div>
  );
}

export interface RingtonePref {
  readonly enabled: boolean;
  readonly set: (next: boolean) => void;
}

function SoundSwitches({ ringtone, ringback }: { readonly ringtone: RingtonePref; readonly ringback: RingtonePref }): JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      <Switch id="ringtone" label={t('settings.ringtone')} hint={t('settings.ringtone.hint')} checked={ringtone.enabled} onChange={ringtone.set} />
      <Switch id="ringback" label={t('settings.ringback')} hint={t('settings.ringback.hint')} checked={ringback.enabled} onChange={ringback.set} />
    </>
  );
}

interface SettingsProps {
  readonly update: UpdateStatus;
  readonly ringtone: RingtonePref;
  readonly ringback: RingtonePref;
  readonly userAgent: UserAgentPref;
}

export function SettingsPanel({ update, ringtone, ringback, userAgent }: SettingsProps): JSX.Element {
  const { t } = useTranslation();
  const permissions = usePermissions();
  return (
    <div className="panel form">
      <LanguageSelect />
      <ThemeSelect />
      <SoundSwitches ringtone={ringtone} ringback={ringback} />
      <UserAgentField pref={userAgent} />
      <PermissionsSection model={permissions} />
      <p className="muted" role="status">
        {updateText(t, update)}
      </p>
    </div>
  );
}
