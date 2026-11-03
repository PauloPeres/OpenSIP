import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { FALLBACK_LOCALE, createTranslator } from '@core/i18n';
import type { Locale, TranslationParams } from '@core/i18n';

export interface TranslationApi {
  readonly t: (key: string, params?: TranslationParams) => string;
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => Promise<void>;
}

const TranslatorContext = createContext<TranslationApi | null>(null);

function useLocaleState(): readonly [Locale, (next: Locale) => Promise<void>] {
  const [locale, setLocaleState] = useState<Locale>(FALLBACK_LOCALE);
  useEffect(() => {
    window.opensip
      .getLocale()
      .then(setLocaleState)
      .catch(() => setLocaleState(FALLBACK_LOCALE));
  }, []);
  const setLocale = useCallback(async (next: Locale): Promise<void> => {
    setLocaleState(await window.opensip.setLocale(next));
  }, []);
  return [locale, setLocale];
}

export function TranslatorProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const [locale, setLocale] = useLocaleState();
  const value = useMemo<TranslationApi>(() => {
    const translator = createTranslator(locale);
    return { t: translator.t, locale, setLocale };
  }, [locale, setLocale]);
  return <TranslatorContext.Provider value={value}>{children}</TranslatorContext.Provider>;
}

export function useTranslation(): TranslationApi {
  const context = useContext(TranslatorContext);
  // i18n-exempt: developer error, never shown to users
  if (context === null) throw new Error('useTranslation requires TranslatorProvider');
  return context;
}
