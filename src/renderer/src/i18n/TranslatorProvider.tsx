import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { FALLBACK_LOCALE, createTranslator } from '@core/i18n';
import { getApi } from '../state/api';
import { isTranslationKey, resolveParams } from './resolveParams';
import type { Locale, TranslationParams } from '@core/i18n';

export interface TranslationApi {
  readonly t: (key: string, params?: TranslationParams) => string;
  /**
   * For keys that arrived over IPC and so cannot be checked at build time. Never throws: an unknown key is
   * shown as itself, which tells the user something happened and tells us what to add. A param that is
   * itself a translation key is translated first. Keys written in the renderer still go through `t`.
   */
  readonly tw: (key: string, params?: TranslationParams) => string;
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => Promise<void>;
}

const TranslatorContext = createContext<TranslationApi | null>(null);

function useLocaleState(): readonly [Locale, (next: Locale) => Promise<void>] {
  const [locale, setLocaleState] = useState<Locale>(FALLBACK_LOCALE);
  useEffect(() => {
    getApi()
      .getLocale()
      .then(setLocaleState)
      .catch(() => setLocaleState(FALLBACK_LOCALE));
  }, []);
  const setLocale = useCallback(async (next: Locale): Promise<void> => {
    setLocaleState(await getApi().setLocale(next));
  }, []);
  return [locale, setLocale];
}

export function TranslatorProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const [locale, setLocale] = useLocaleState();
  const value = useMemo<TranslationApi>(() => {
    const translator = createTranslator(locale);
    const tw = (key: string, params?: TranslationParams): string =>
      isTranslationKey(locale, key) ? translator.t(key, resolveParams(locale, translator.t, params)) : key;
    return { t: translator.t, tw, locale, setLocale };
  }, [locale, setLocale]);
  return <TranslatorContext.Provider value={value}>{children}</TranslatorContext.Provider>;
}

export function useTranslation(): TranslationApi {
  const context = useContext(TranslatorContext);
  // i18n-exempt: developer error, never shown to users
  if (context === null) throw new Error('useTranslation requires TranslatorProvider');
  return context;
}
