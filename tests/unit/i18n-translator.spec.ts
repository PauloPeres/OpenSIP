import { describe, expect, it } from 'vitest';
import {
  FALLBACK_LOCALE,
  MissingTranslationError,
  MissingTranslationParamError,
  SUPPORTED_LOCALES,
  createTranslator,
  dictionaries,
  isSupportedLocale,
  resolveLocale
} from '../../src/core/i18n';
import en from '../../src/core/i18n/locales/en.json';
import ptBR from '../../src/core/i18n/locales/pt-BR.json';

describe('locale helpers', () => {
  it('exposes supported locales and fallback', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en', 'pt-BR']);
    expect(FALLBACK_LOCALE).toBe('en');
  });

  it('isSupportedLocale accepts only exact supported values', () => {
    expect(isSupportedLocale('en')).toBe(true);
    expect(isSupportedLocale('pt-BR')).toBe(true);
    expect(isSupportedLocale('pt-br')).toBe(false);
    expect(isSupportedLocale('fr')).toBe(false);
    expect(isSupportedLocale('')).toBe(false);
  });

  it('resolveLocale maps pt variants case-insensitively', () => {
    expect(resolveLocale('pt')).toBe('pt-BR');
    expect(resolveLocale('PT')).toBe('pt-BR');
    expect(resolveLocale('pt-br')).toBe('pt-BR');
    expect(resolveLocale('pt-BR')).toBe('pt-BR');
  });

  it('resolveLocale maps en and falls back otherwise', () => {
    expect(resolveLocale('en')).toBe('en');
    expect(resolveLocale('EN')).toBe('en');
    expect(resolveLocale('fr')).toBe('en');
    expect(resolveLocale('pt-PT')).toBe('en');
    expect(resolveLocale('')).toBe('en');
    expect(resolveLocale(undefined)).toBe('en');
    expect(resolveLocale(null)).toBe('en');
  });
});

describe('dictionaries', () => {
  it('have identical key sets', () => {
    expect(Object.keys(ptBR).sort()).toEqual(Object.keys(en).sort());
  });

  it('are exported by locale', () => {
    expect(dictionaries.en).toBe(en);
    expect(dictionaries['pt-BR']).toBe(ptBR);
  });

  it('use required placeholders', () => {
    for (const d of [en, ptBR] as Record<string, string>[]) {
      expect(d['calls.incomingFrom']).toContain('{caller}');
      expect(d['settings.updates.available']).toContain('{version}');
    }
  });
});

describe('createTranslator', () => {
  it('reports its locale', () => {
    expect(createTranslator('en').locale).toBe('en');
    expect(createTranslator('pt-BR').locale).toBe('pt-BR');
  });

  it('returns strings from the requested locale', () => {
    expect(createTranslator('en').t('nav.accounts')).toBe(en['nav.accounts']);
    expect(createTranslator('pt-BR').t('nav.accounts')).toBe(ptBR['nav.accounts']);
    expect(en['nav.accounts']).not.toBe(ptBR['nav.accounts']);
  });

  it('falls back to en when key is missing in pt-BR', () => {
    const t = createTranslator('pt-BR', { en: { only: 'English only' }, 'pt-BR': {} });
    expect(t.t('only')).toBe('English only');
  });

  it('throws MissingTranslationError with key and locale when missing everywhere', () => {
    const t = createTranslator('pt-BR');
    expect(() => t.t('no.such.key')).toThrow(MissingTranslationError);
    try {
      t.t('no.such.key');
      expect.unreachable();
    } catch (e) {
      const err = e as MissingTranslationError;
      expect(err.key).toBe('no.such.key');
      expect(err.locale).toBe('pt-BR');
      expect(err.name).toBe('MissingTranslationError');
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('does not treat inherited object properties as keys', () => {
    expect(() => createTranslator('en').t('toString')).toThrow(MissingTranslationError);
  });

  it('treats an empty-string translation as present', () => {
    const t = createTranslator('en', { en: { blank: '' }, 'pt-BR': {} });
    expect(t.t('blank')).toBe('');
  });
});

describe('interpolation', () => {
  const dicts = {
    en: {
      greet: 'Hi {name}, {name}! You have {count} calls',
      plain: 'no params',
      raw: 'value: {a}',
      pair: '{a}-{b}'
    },
    'pt-BR': {}
  };
  const t = createTranslator('en', dicts);

  it('substitutes every occurrence and stringifies numbers', () => {
    expect(t.t('greet', { name: 'Ana', count: 2 })).toBe('Hi Ana, Ana! You have 2 calls');
    expect(t.t('greet', { name: 'Ana', count: 0 })).toBe('Hi Ana, Ana! You have 0 calls');
  });

  it('ignores unused params and leaves plain strings alone', () => {
    expect(t.t('plain', { x: 1 })).toBe('no params');
    expect(t.t('plain')).toBe('no params');
  });

  it('throws MissingTranslationParamError for absent placeholders', () => {
    expect(() => t.t('raw')).toThrow(MissingTranslationParamError);
    try {
      t.t('raw', { other: 'x' });
      expect.unreachable();
    } catch (e) {
      const err = e as MissingTranslationParamError;
      expect(err.key).toBe('raw');
      expect(err.param).toBe('a');
      expect(err.name).toBe('MissingTranslationParamError');
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(MissingTranslationError);
    }
  });

  it('does not re-scan substituted text', () => {
    expect(t.t('pair', { a: '{b}', b: 'B' })).toBe('{b}-B');
    expect(t.t('raw', { a: '{a}' })).toBe('value: {a}');
  });

  it('does not use inherited properties as params', () => {
    expect(() => t.t('raw', {})).toThrow(MissingTranslationParamError);
    const dict = { en: { k: '{toString}' }, 'pt-BR': {} };
    expect(() => createTranslator('en', dict).t('k')).toThrow(MissingTranslationParamError);
  });

  it('works with the real dictionaries in both locales', () => {
    expect(createTranslator('en').t('calls.incomingFrom', { caller: 'Bob' })).toContain('Bob');
    expect(createTranslator('pt-BR').t('settings.updates.available', { version: '1.2.3' })).toContain('1.2.3');
  });
});

describe('resolveLocale alias table', () => {
  it.each([
    ['en', 'en'],
    ['en-US', 'en'],
    ['EN', 'en'],
    ['pt', 'pt-BR'],
    ['pt-BR', 'pt-BR'],
    ['PT-br', 'pt-BR'],
    ['  pt-br  ', 'pt-BR']
  ])('maps %s to %s', (requested, expected) => {
    expect(resolveLocale(requested)).toBe(expected);
  });

  it.each(['', '   ', 'es', 'fr-FR', 'constructor', 'toString', 'hasOwnProperty'])(
    'falls back to en for %s',
    (requested) => {
      expect(resolveLocale(requested)).toBe('en');
    }
  );
});
