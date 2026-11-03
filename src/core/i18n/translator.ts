import { FALLBACK_LOCALE, SUPPORTED_LOCALES } from './types';
import type { Dictionary, Locale, TranslationParams, Translator } from './types';
import en from './locales/en.json';
import ptBR from './locales/pt-BR.json';

export const dictionaries: Readonly<Record<Locale, Dictionary>> = {
  en,
  'pt-BR': ptBR
};

const PLACEHOLDER = /\{(\w+)\}/g;

export class MissingTranslationError extends Error {
  readonly key: string;
  readonly locale: Locale;

  constructor(key: string, locale: Locale) {
    super(`Missing translation for "${key}" in locale "${locale}"`);
    this.name = 'MissingTranslationError';
    this.key = key;
    this.locale = locale;
  }
}

export class MissingTranslationParamError extends Error {
  readonly key: string;
  readonly param: string;

  constructor(key: string, param: string) {
    super(`Missing param "${param}" for translation "${key}"`);
    this.name = 'MissingTranslationParamError';
    this.key = key;
    this.param = param;
  }
}

export function isSupportedLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

const LOCALE_ALIASES = new Map<string, Locale>([
  ['en', 'en'],
  ['en-us', 'en'],
  ['pt', 'pt-BR'],
  ['pt-br', 'pt-BR']
]);

export function resolveLocale(requested: string | undefined | null): Locale {
  const normalized = (requested ?? '').trim().toLowerCase();
  return LOCALE_ALIASES.get(normalized) ?? FALLBACK_LOCALE;
}

function lookup(dict: Dictionary, key: string): string | undefined {
  return Object.hasOwn(dict, key) ? dict[key] : undefined;
}

function interpolate(key: string, template: string, params: TranslationParams): string {
  return template.replace(PLACEHOLDER, (_match: string, name: string): string => {
    if (!Object.hasOwn(params, name)) {
      throw new MissingTranslationParamError(key, name);
    }
    return String(params[name]);
  });
}

export function createTranslator(
  locale: Locale,
  source: Readonly<Record<Locale, Dictionary>> = dictionaries
): Translator {
  return {
    locale,
    t(key: string, params: TranslationParams = {}): string {
      const template = lookup(source[locale], key) ?? lookup(source[FALLBACK_LOCALE], key);
      if (template === undefined) {
        throw new MissingTranslationError(key, locale);
      }
      return interpolate(key, template, params);
    }
  };
}
