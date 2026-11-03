export type Locale = 'en' | 'pt-BR';

export const SUPPORTED_LOCALES: readonly Locale[] = ['en', 'pt-BR'];

export const FALLBACK_LOCALE: Locale = 'en';

export type TranslationParams = Readonly<Record<string, string | number>>;

export type Dictionary = Readonly<Record<string, string>>;

export interface Translator {
  readonly locale: Locale;
  t(key: string, params?: TranslationParams): string;
}
