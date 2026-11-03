/*
 * Contact bindings in a REGISTER 200 OK (RFC 3261 10.2.4).
 *
 * The registrar lists every contact currently bound to our address of record.
 * Reading that list tells us whether another device shares the account, and
 * whether the server has silently replaced our own binding with theirs.
 */
import { parseUri } from './message';

export interface ContactBinding {
  /** `scheme:user@host:port`, host lowercased, port defaulted, parameters dropped. */
  readonly uri: string;
  readonly expires?: number;
  readonly raw: string;
}

export interface BindingOwner {
  readonly host: string;
  readonly port: number;
  readonly user: string;
}

export interface BindingAnalysis {
  readonly others: number;
  readonly displaced: boolean;
}

interface Identity {
  readonly scheme: string;
  readonly user: string;
  readonly host: string;
  readonly port: number;
}

/** Where the scanner is: outside everything, in a quoted string, after a backslash in one, or in <...>. */
type Mode = 'plain' | 'quoted' | 'escaped' | 'angle';

const DEFAULT_PORTS: Readonly<Record<string, number>> = { sip: 5060, sips: 5061 };
const NAME_ADDR = /^\s*(?:"(?:[^"\\]|\\.)*"|[^<"]*)\s*<([^>]*)>(.*)/s;
const ADDR_SPEC = /([^;]*)(.*)/s;
const EXPIRES = /^expires\s*=\s*(?:"(\d+)"|(\d+))$/i;

const AFTER_PLAIN: Readonly<Record<string, Mode>> = { '"': 'quoted', '<': 'angle' };
const AFTER_QUOTED: Readonly<Record<string, Mode>> = { '\\': 'escaped', '"': 'plain' };
const AFTER_ANGLE: Readonly<Record<string, Mode>> = { '>': 'plain' };

const STEP: Readonly<Record<Mode, (char: string) => Mode>> = {
  plain: (char) => AFTER_PLAIN[char] ?? 'plain',
  quoted: (char) => AFTER_QUOTED[char] ?? 'quoted',
  escaped: () => 'quoted',
  angle: (char) => AFTER_ANGLE[char] ?? 'angle'
};

const nextMode = (mode: Mode, char: string): Mode => STEP[mode](char);

/** Positions of the separator outside quoted strings and angle brackets. */
function topLevelCuts(value: string, separator: string): readonly number[] {
  const cuts: number[] = [];
  let mode: Mode = 'plain';
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);
    if (char === separator && mode === 'plain') cuts.push(index);
    mode = nextMode(mode, char);
  }
  return cuts;
}

function splitTop(value: string, separator: string): readonly string[] {
  const bounds = [-1, ...topLevelCuts(value, separator), value.length];
  return bounds.slice(0, -1).map((from, index) => value.slice(from + 1, bounds[index + 1]).trim());
}

function splitAddress(text: string): { readonly uri: string; readonly params: string } {
  const match = (NAME_ADDR.exec(text) ?? ADDR_SPEC.exec(text)) as RegExpExecArray;
  const [uri, params] = match.slice(1) as [string, string];
  return { uri, params };
}

function identityOf(uri: string): Identity | undefined {
  try {
    const parsed = parseUri(uri.trim());
    const scheme = parsed.scheme.toLowerCase();
    const port = parsed.port ?? DEFAULT_PORTS[scheme];
    if (port === undefined) return undefined;
    return { scheme, user: parsed.user ?? '', host: parsed.host.toLowerCase(), port };
  } catch {
    return undefined;
  }
}

const normalised = ({ scheme, user, host, port }: Identity): string =>
  `${scheme}:${user === '' ? '' : `${user}@`}${host}:${port}`;

function expiresOf(params: string): number | undefined {
  const found = splitTop(params, ';')
    .map((segment) => EXPIRES.exec(segment))
    .find((match) => match !== null);
  const digits = found?.[1] ?? found?.[2];
  return digits === undefined ? undefined : Number(digits);
}

function toBinding(text: string): ContactBinding | undefined {
  const { uri, params } = splitAddress(text);
  const identity = identityOf(uri);
  if (identity === undefined) return undefined;
  const expires = expiresOf(params);
  return { uri: normalised(identity), raw: text, ...(expires === undefined ? {} : { expires }) };
}

/** Every contact in the given Contact header values; a value may carry several, comma separated. */
export function parseContactBindings(headerValues: readonly string[]): readonly ContactBinding[] {
  return headerValues
    .flatMap((value) => splitTop(value, ','))
    .map(toBinding)
    .filter((binding): binding is ContactBinding => binding !== undefined);
}

/** User, host (case-insensitive) and port decide; transport and other parameters do not. */
export function isOurBinding(binding: ContactBinding, ours: BindingOwner): boolean {
  const identity = identityOf(binding.uri);
  return (
    identity !== undefined &&
    identity.user === ours.user &&
    identity.host === ours.host.toLowerCase() &&
    identity.port === ours.port
  );
}

/** A binding with expires=0 is being removed, so it is not really there. */
const isLive = (binding: ContactBinding): boolean => binding.expires !== 0;

export function otherBindings(headerValues: readonly string[], ours: BindingOwner): readonly ContactBinding[] {
  return parseContactBindings(headerValues).filter((binding) => isLive(binding) && !isOurBinding(binding, ours));
}

/**
 * `displaced` needs at least one live binding and none of them ours. An empty
 * list means the server told us nothing, which is not evidence of anything.
 */
export function analyseBindings(headerValues: readonly string[], ours: BindingOwner): BindingAnalysis {
  const live = parseContactBindings(headerValues).filter(isLive);
  const others = live.filter((binding) => !isOurBinding(binding, ours)).length;
  return { others, displaced: live.length > 0 && others === live.length };
}
