import { FALLBACK_LOCALE, dictionaries } from '@core/i18n';
import type { Locale, TranslationParams } from '@core/i18n';

type Translate = (key: string) => string;

/** True only when `value` is itself an entry of the dictionary, so ordinary data is never mistaken for a key. */
export function isTranslationKey(locale: Locale, value: string | number): value is string {
  return typeof value === 'string' && (Object.hasOwn(dictionaries[locale], value) || Object.hasOwn(dictionaries[FALLBACK_LOCALE], value));
}

/** Params may carry i18n keys (the engine reports why something failed that way); turn those into text and leave data alone. */
export function resolveParams(locale: Locale, t: Translate, params: TranslationParams | undefined): TranslationParams | undefined {
  if (params === undefined) return undefined;
  const entries = Object.entries(params).map(([name, value]) => [name, isTranslationKey(locale, value) ? t(value) : value] as const);
  return Object.fromEntries(entries);
}
