import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MalformedChallengeError,
  UnsupportedAlgorithmError,
  buildAuthorization,
  parseChallenge
} from '../../src/core/sip/digest';
import type { DigestChallenge, DigestCredentials } from '../../src/core/sip/digest';

const md5 = (input: string): string => createHash('md5').update(input, 'utf8').digest('hex');

const RFC_HEADER =
  'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"';

const challenge = (overrides: Partial<DigestChallenge> = {}): DigestChallenge => ({
  scheme: 'Digest',
  realm: 'testrealm@host.com',
  nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
  algorithm: 'MD5',
  qop: ['auth'],
  stale: false,
  ...overrides
});

const credentials = (overrides: Partial<DigestCredentials> = {}): DigestCredentials => ({
  challenge: challenge(),
  username: 'Mufasa',
  password: 'Circle Of Life',
  method: 'GET',
  digestUri: '/dir/index.html',
  nonceCount: 1,
  cnonce: '0a4f113b',
  hash: md5,
  ...overrides
});

const field = (header: string, name: string): string | undefined =>
  new RegExp(`[ ,]${name}=("[^"]*"|[^,]*)`).exec(header)?.[1];

describe('parseChallenge', () => {
  it('parses the RFC 2617 example', () => {
    expect(parseChallenge(RFC_HEADER)).toEqual({
      scheme: 'Digest',
      realm: 'testrealm@host.com',
      nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
      opaque: '5ccc069c403ebaf9f0171e9517f40e41',
      algorithm: 'MD5',
      qop: ['auth', 'auth-int'],
      stale: false
    });
  });

  it('omits opaque when absent and defaults algorithm and qop', () => {
    const parsed = parseChallenge('Digest realm="r", nonce="n"');
    expect(parsed).toEqual({ scheme: 'Digest', realm: 'r', nonce: 'n', algorithm: 'MD5', qop: [], stale: false });
    expect('opaque' in parsed).toBe(false);
  });

  it('is case-insensitive on the scheme and parameter names', () => {
    const parsed = parseChallenge('DIGEST REALM="r", Nonce="n", QOP="auth", Algorithm=md5-SESS, STALE=TRUE, Opaque="o"');
    expect(parsed).toEqual({
      scheme: 'Digest',
      realm: 'r',
      nonce: 'n',
      opaque: 'o',
      algorithm: 'MD5-sess',
      qop: ['auth'],
      stale: true
    });
  });

  it('tolerates whitespace around = and ,', () => {
    const parsed = parseChallenge('  Digest   realm = "r"  ,nonce\t=\t"n" ,   qop = "auth"');
    expect(parsed.realm).toBe('r');
    expect(parsed.nonce).toBe('n');
    expect(parsed.qop).toEqual(['auth']);
  });

  it('accepts unquoted values', () => {
    const parsed = parseChallenge('Digest realm=r, nonce=abc123, algorithm=MD5, stale=false');
    expect(parsed.realm).toBe('r');
    expect(parsed.nonce).toBe('abc123');
    expect(parsed.algorithm).toBe('MD5');
  });

  it('keeps commas inside quoted values', () => {
    const parsed = parseChallenge('Digest realm="a, b=c, d", nonce="n"');
    expect(parsed.realm).toBe('a, b=c, d');
  });

  it('unescapes quoted pairs', () => {
    expect(parseChallenge('Digest realm="a\\"b\\\\c", nonce="n"').realm).toBe('a"b\\c');
  });

  it('keeps qop offered as a single token and ignores unknown tokens', () => {
    expect(parseChallenge('Digest realm="r", nonce="n", qop="auth-int"').qop).toEqual(['auth-int']);
    expect(parseChallenge('Digest realm="r", nonce="n", qop="foo, auth"').qop).toEqual(['auth']);
    expect(parseChallenge('Digest realm="r", nonce="n", qop="AUTH , Auth-Int"').qop).toEqual(['auth', 'auth-int']);
  });

  it('treats stale as true only for the value true', () => {
    expect(parseChallenge('Digest realm="r", nonce="n", stale=true').stale).toBe(true);
    expect(parseChallenge('Digest realm="r", nonce="n", stale="True"').stale).toBe(true);
    expect(parseChallenge('Digest realm="r", nonce="n", stale=false').stale).toBe(false);
    expect(parseChallenge('Digest realm="r", nonce="n", stale=yes').stale).toBe(false);
    expect(parseChallenge('Digest realm="r", nonce="n"').stale).toBe(false);
  });

  it('accepts an empty realm as present', () => {
    expect(parseChallenge('Digest realm="", nonce="n"').realm).toBe('');
  });

  it('rejects a missing realm', () => {
    expect(() => parseChallenge('Digest nonce="n"')).toThrow(MalformedChallengeError);
  });

  it('rejects a missing nonce', () => {
    expect(() => parseChallenge('Digest realm="r"')).toThrow(MalformedChallengeError);
  });

  it('rejects an empty header and a scheme without parameters', () => {
    expect(() => parseChallenge('')).toThrow(MalformedChallengeError);
    expect(() => parseChallenge('Digest')).toThrow(MalformedChallengeError);
    expect(() => parseChallenge('Digest ')).toThrow(MalformedChallengeError);
  });

  it('rejects other schemes', () => {
    expect(() => parseChallenge('Basic realm="r"')).toThrow(MalformedChallengeError);
    expect(() => parseChallenge('Digestx realm="r", nonce="n"')).toThrow(MalformedChallengeError);
    expect(() => parseChallenge('realm="r", nonce="n"')).toThrow(MalformedChallengeError);
  });

  it('carries a short identifier as the error message', () => {
    expect(() => parseChallenge('Basic')).toThrowError('malformed-challenge');
    try {
      parseChallenge('Basic');
    } catch (error) {
      expect((error as Error).name).toBe('MalformedChallengeError');
    }
  });

  it('rejects unsupported algorithms and reports the offending value', () => {
    let caught: unknown;
    try {
      parseChallenge('Digest realm="r", nonce="n", algorithm=SHA-256');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnsupportedAlgorithmError);
    expect((caught as UnsupportedAlgorithmError).algorithm).toBe('SHA-256');
    expect((caught as UnsupportedAlgorithmError).message).toBe('unsupported-algorithm');
    expect((caught as UnsupportedAlgorithmError).name).toBe('UnsupportedAlgorithmError');
  });

  it('accepts MD5 and MD5-sess in any case', () => {
    expect(parseChallenge('Digest realm="r", nonce="n", algorithm="md5"').algorithm).toBe('MD5');
    expect(parseChallenge('Digest realm="r", nonce="n", algorithm=MD5-sess').algorithm).toBe('MD5-sess');
  });
});

describe('buildAuthorization', () => {
  it('reproduces the RFC 2617 section 3.5 worked example', () => {
    const header = buildAuthorization(credentials());
    expect(field(header, 'response')).toBe('"6629fae49393a05397450978507c4ef1"');
  });

  it('emits the exact header layout with quoted and unquoted fields', () => {
    expect(buildAuthorization(credentials({ challenge: challenge({ opaque: '5ccc069c403ebaf9f0171e9517f40e41' }) }))).toBe(
      'Digest username="Mufasa", realm="testrealm@host.com", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", ' +
        'uri="/dir/index.html", response="6629fae49393a05397450978507c4ef1", algorithm=MD5, ' +
        'cnonce="0a4f113b", qop=auth, nc=00000001, opaque="5ccc069c403ebaf9f0171e9517f40e41"'
    );
  });

  it('computes the no-qop response as hash(HA1:nonce:HA2)', () => {
    const c = challenge({ qop: [] });
    const ha1 = md5('Mufasa:testrealm@host.com:Circle Of Life');
    const ha2 = md5('GET:/dir/index.html');
    const expected = md5(`${ha1}:${c.nonce}:${ha2}`);
    const header = buildAuthorization(credentials({ challenge: c }));
    expect(field(header, 'response')).toBe(`"${expected}"`);
    expect(header).toBe(
      `Digest username="Mufasa", realm="testrealm@host.com", nonce="${c.nonce}", ` +
        `uri="/dir/index.html", response="${expected}", algorithm=MD5`
    );
  });

  it('computes MD5-sess HA1 from the inner hash, nonce and cnonce', () => {
    const c = challenge({ algorithm: 'MD5-sess' });
    const inner = md5('Mufasa:testrealm@host.com:Circle Of Life');
    const ha1 = md5(`${inner}:${c.nonce}:0a4f113b`);
    const ha2 = md5('GET:/dir/index.html');
    const expected = md5(`${ha1}:${c.nonce}:00000001:0a4f113b:auth:${ha2}`);
    const header = buildAuthorization(credentials({ challenge: c }));
    expect(field(header, 'response')).toBe(`"${expected}"`);
    expect(field(header, 'algorithm')).toBe('MD5-sess');
  });

  it('keeps the cnonce for MD5-sess without qop', () => {
    const c = challenge({ algorithm: 'MD5-sess', qop: [] });
    const header = buildAuthorization(credentials({ challenge: c }));
    expect(field(header, 'cnonce')).toBe('"0a4f113b"');
    expect(field(header, 'qop')).toBeUndefined();
    expect(field(header, 'nc')).toBeUndefined();
  });

  it('hashes the body for auth-int', () => {
    const c = challenge({ qop: ['auth-int'] });
    const ha1 = md5('Mufasa:testrealm@host.com:Circle Of Life');
    const ha2 = md5(`GET:/dir/index.html:${md5('v=0\r\n')}`);
    const expected = md5(`${ha1}:${c.nonce}:00000001:0a4f113b:auth-int:${ha2}`);
    const header = buildAuthorization(credentials({ challenge: c, body: 'v=0\r\n' }));
    expect(field(header, 'response')).toBe(`"${expected}"`);
    expect(field(header, 'qop')).toBe('auth-int');
  });

  it('treats a missing body as empty for auth-int', () => {
    const c = challenge({ qop: ['auth-int'] });
    const withUndefined = buildAuthorization(credentials({ challenge: c }));
    const withEmpty = buildAuthorization(credentials({ challenge: c, body: '' }));
    expect(withUndefined).toBe(withEmpty);
    const ha2 = md5(`GET:/dir/index.html:${md5('')}`);
    const ha1 = md5('Mufasa:testrealm@host.com:Circle Of Life');
    expect(field(withEmpty, 'response')).toBe(`"${md5(`${ha1}:${c.nonce}:00000001:0a4f113b:auth-int:${ha2}`)}"`);
  });

  it('ignores the body when the qop is auth', () => {
    const plain = buildAuthorization(credentials());
    expect(buildAuthorization(credentials({ body: 'ignored' }))).toBe(plain);
  });

  it('prefers auth when the server offers both, whatever the order', () => {
    const base = buildAuthorization(credentials());
    expect(buildAuthorization(credentials({ challenge: challenge({ qop: ['auth', 'auth-int'] }) }))).toBe(base);
    expect(buildAuthorization(credentials({ challenge: challenge({ qop: ['auth-int', 'auth'] }) }))).toBe(base);
  });

  it.each([
    [1, '00000001'],
    [15, '0000000f'],
    [16, '00000010'],
    [255, '000000ff'],
    [4294967295, 'ffffffff']
  ])('encodes nonce count %i as %s', (count, hex) => {
    const header = buildAuthorization(credentials({ nonceCount: count }));
    expect(field(header, 'nc')).toBe(hex);
    const ha1 = md5('Mufasa:testrealm@host.com:Circle Of Life');
    const ha2 = md5('GET:/dir/index.html');
    const expected = md5(`${ha1}:dcd98b7102dd2f0e8b11d0f600bfb0c093:${hex}:0a4f113b:auth:${ha2}`);
    expect(field(header, 'response')).toBe(`"${expected}"`);
  });

  it('omits opaque when the challenge had none', () => {
    expect(buildAuthorization(credentials())).not.toContain('opaque');
  });

  it('escapes quotes and backslashes in quoted fields', () => {
    const header = buildAuthorization(credentials({ username: 'a"b\\c' }));
    expect(header).toContain('username="a\\"b\\\\c"');
  });

  it('round-trips a parsed challenge', () => {
    const header = buildAuthorization(credentials({ challenge: parseChallenge(RFC_HEADER) }));
    expect(field(header, 'response')).toBe('"6629fae49393a05397450978507c4ef1"');
    expect(field(header, 'opaque')).toBe('"5ccc069c403ebaf9f0171e9517f40e41"');
  });

  it('uses the injected hash function only', () => {
    const calls: string[] = [];
    const header = buildAuthorization(
      credentials({
        hash: (input) => {
          calls.push(input);
          return 'h';
        }
      })
    );
    expect(calls).toEqual(['Mufasa:testrealm@host.com:Circle Of Life', 'GET:/dir/index.html', 'h:dcd98b7102dd2f0e8b11d0f600bfb0c093:00000001:0a4f113b:auth:h']);
    expect(header).toContain('response="h"');
  });
});
