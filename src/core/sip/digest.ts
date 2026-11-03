export type DigestQop = 'auth' | 'auth-int';
export type DigestAlgorithm = 'MD5' | 'MD5-sess';

export interface DigestChallenge {
  readonly scheme: 'Digest';
  readonly realm: string;
  readonly nonce: string;
  readonly opaque?: string;
  readonly algorithm: DigestAlgorithm;
  readonly qop: readonly DigestQop[];
  readonly stale: boolean;
}

export type HashFn = (input: string) => string;

export interface DigestCredentials {
  readonly challenge: DigestChallenge;
  readonly username: string;
  readonly password: string;
  readonly method: string;
  readonly digestUri: string;
  readonly nonceCount: number;
  readonly cnonce: string;
  readonly body?: string;
  readonly hash: HashFn;
}

export class MalformedChallengeError extends Error {
  constructor() {
    super('malformed-challenge');
    this.name = 'MalformedChallengeError';
  }
}

export class UnsupportedAlgorithmError extends Error {
  readonly algorithm: string;

  constructor(algorithm: string) {
    super('unsupported-algorithm');
    this.name = 'UnsupportedAlgorithmError';
    this.algorithm = algorithm;
  }
}

const SCHEME = /^\s*digest(?:\s+([\s\S]*))?$/i;
const PARAMETER = /([A-Za-z][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\[\s\S])*)"|([^\s,"]*))/g;
const QOP_SEPARATOR = /[\s,]+/;

function unescapeQuoted(value: string): string {
  return value.replace(/\\([\s\S])/g, '$1');
}

function parseParameters(text: string): ReadonlyMap<string, string> {
  const entries = [...text.matchAll(PARAMETER)].map((match): readonly [string, string] => [
    (match[1] ?? '').toLowerCase(),
    match[2] === undefined ? (match[3] ?? '') : unescapeQuoted(match[2])
  ]);
  return new Map(entries);
}

function required(parameters: ReadonlyMap<string, string>, name: string): string {
  const value = parameters.get(name);
  if (value === undefined) throw new MalformedChallengeError();
  return value;
}

function parseAlgorithm(raw: string | undefined): DigestAlgorithm {
  const upper = (raw ?? 'MD5').toUpperCase();
  if (upper === 'MD5') return 'MD5';
  if (upper === 'MD5-SESS') return 'MD5-sess';
  throw new UnsupportedAlgorithmError(raw ?? '');
}

function parseQop(raw: string | undefined): readonly DigestQop[] {
  const tokens = (raw ?? '').toLowerCase().split(QOP_SEPARATOR);
  return tokens.filter((token): token is DigestQop => token === 'auth' || token === 'auth-int');
}

export function parseChallenge(headerValue: string): DigestChallenge {
  const scheme = SCHEME.exec(headerValue);
  if (scheme === null) throw new MalformedChallengeError();
  const parameters = parseParameters(scheme[1] ?? '');
  const opaque = parameters.get('opaque');
  return {
    scheme: 'Digest',
    realm: required(parameters, 'realm'),
    nonce: required(parameters, 'nonce'),
    ...(opaque === undefined ? {} : { opaque }),
    algorithm: parseAlgorithm(parameters.get('algorithm')),
    qop: parseQop(parameters.get('qop')),
    stale: parameters.get('stale')?.toLowerCase() === 'true'
  };
}

function chooseQop(offered: readonly DigestQop[]): DigestQop | undefined {
  return offered.includes('auth') ? 'auth' : offered[0];
}

function computeHa1(credentials: DigestCredentials): string {
  const { challenge, username, password, cnonce, hash } = credentials;
  const base = hash(`${username}:${challenge.realm}:${password}`);
  return challenge.algorithm === 'MD5-sess' ? hash(`${base}:${challenge.nonce}:${cnonce}`) : base;
}

function computeHa2(credentials: DigestCredentials, qop: DigestQop | undefined): string {
  const { method, digestUri, body, hash } = credentials;
  const target = `${method}:${digestUri}`;
  return hash(qop === 'auth-int' ? `${target}:${hash(body ?? '')}` : target);
}

function formatNonceCount(count: number): string {
  return count.toString(16).padStart(8, '0');
}

function computeResponse(credentials: DigestCredentials, qop: DigestQop | undefined): string {
  const { challenge, nonceCount, cnonce, hash } = credentials;
  const ha1 = computeHa1(credentials);
  const ha2 = computeHa2(credentials, qop);
  if (qop === undefined) return hash(`${ha1}:${challenge.nonce}:${ha2}`);
  return hash(`${ha1}:${challenge.nonce}:${formatNonceCount(nonceCount)}:${cnonce}:${qop}:${ha2}`);
}

const quote = (value: string): string => `"${value.replace(/(["\\])/g, '\\$1')}"`;

function optionalFields(credentials: DigestCredentials, qop: DigestQop | undefined): readonly string[] {
  const { challenge, cnonce, nonceCount } = credentials;
  const needsCnonce = qop !== undefined || challenge.algorithm === 'MD5-sess';
  return [
    ...(needsCnonce ? [`cnonce=${quote(cnonce)}`] : []),
    ...(qop === undefined ? [] : [`qop=${qop}`, `nc=${formatNonceCount(nonceCount)}`]),
    ...(challenge.opaque === undefined ? [] : [`opaque=${quote(challenge.opaque)}`])
  ];
}

export function buildAuthorization(credentials: DigestCredentials): string {
  const { challenge, username, digestUri } = credentials;
  const qop = chooseQop(challenge.qop);
  const fields = [
    `username=${quote(username)}`,
    `realm=${quote(challenge.realm)}`,
    `nonce=${quote(challenge.nonce)}`,
    `uri=${quote(digestUri)}`,
    `response=${quote(computeResponse(credentials, qop))}`,
    `algorithm=${challenge.algorithm}`,
    ...optionalFields(credentials, qop)
  ];
  return `Digest ${fields.join(', ')}`;
}
