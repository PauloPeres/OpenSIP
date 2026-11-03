export type SipMethod = 'REGISTER' | 'INVITE' | 'ACK' | 'BYE' | 'CANCEL' | 'OPTIONS';
export type SipHeaders = Readonly<Record<string, readonly string[]>>;

export interface SipRequest {
  readonly kind: 'request';
  readonly method: string;
  readonly uri: string;
  readonly headers: SipHeaders;
  readonly body: string;
}

export interface SipResponse {
  readonly kind: 'response';
  readonly status: number;
  readonly reason: string;
  readonly headers: SipHeaders;
  readonly body: string;
}

export type SipMessage = SipRequest | SipResponse;

export interface SipUri {
  readonly scheme: string;
  readonly user?: string;
  readonly host: string;
  readonly port?: number;
  readonly parameters: Readonly<Record<string, string>>;
}

export class MalformedSipMessageError extends Error {
  constructor() {
    super('malformed-sip-message');
    this.name = 'MalformedSipMessageError';
  }
}

type StartLine = Omit<SipRequest, 'headers' | 'body'> | Omit<SipResponse, 'headers' | 'body'>;

interface Head {
  readonly start: StartLine;
  readonly headers: SipHeaders;
}

interface Frame {
  readonly message: SipMessage;
  readonly rest: string;
}

const LINE_BREAK = /\r?\n/;
const HEAD_END = /\r?\n\r?\n/;
const LEADING_BREAKS = /^(?:\r?\n)+/;
const REQUEST_LINE = /^([A-Za-z]+) (\S+) SIP\/2\.0$/;
const STATUS_LINE = /^SIP\/2\.0 (\d{3})(?: (.*))?$/;
const URI_SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):(.+)$/;
const HOST_PORT = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/;
const DIGITS = /^\d+$/;

const MIN_STATUS = 100;
const MAX_STATUS = 699;
const MAX_PORT = 65535;

const COMPACT_FORMS: ReadonlyMap<string, string> = new Map([
  ['i', 'call-id'],
  ['m', 'contact'],
  ['f', 'from'],
  ['t', 'to'],
  ['v', 'via'],
  ['c', 'content-type'],
  ['l', 'content-length'],
  ['s', 'subject'],
  ['k', 'supported']
]);

const CANONICAL_NAMES: ReadonlyMap<string, string> = new Map([
  ['call-id', 'Call-ID'],
  ['cseq', 'CSeq'],
  ['www-authenticate', 'WWW-Authenticate']
]);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const byteLength = (text: string): number => encoder.encode(text).length;

function malformed(): never {
  throw new MalformedSipMessageError();
}

export function headerValues(headers: SipHeaders, name: string): readonly string[] {
  const key = name.toLowerCase();
  return Object.prototype.hasOwnProperty.call(headers, key) ? (headers[key] ?? []) : [];
}

export function headerValue(headers: SipHeaders, name: string): string | undefined {
  return headerValues(headers, name)[0];
}

export function withHeader(headers: SipHeaders, name: string, value: string): SipHeaders {
  return { ...headers, [name.toLowerCase()]: [value] };
}

export function withAddedHeader(headers: SipHeaders, name: string, value: string): SipHeaders {
  return { ...headers, [name.toLowerCase()]: [...headerValues(headers, name), value] };
}

export function isResponse(message: SipMessage): message is SipResponse {
  return message.kind === 'response';
}

export function parseStatusLine(line: string): { readonly status: number; readonly reason: string } {
  const match = STATUS_LINE.exec(line);
  if (match === null) return malformed();
  const status = Number(match[1]);
  if (status < MIN_STATUS || status > MAX_STATUS) return malformed();
  return { status, reason: match[2] ?? '' };
}

function parseStartLine(line: string): StartLine {
  if (line.startsWith('SIP/2.0 ')) return { kind: 'response', ...parseStatusLine(line) };
  const match = REQUEST_LINE.exec(line);
  if (match === null) return malformed();
  return { kind: 'request', method: match[1] ?? '', uri: match[2] ?? '' };
}

function expandName(name: string): string {
  const lower = name.trim().toLowerCase();
  return COMPACT_FORMS.get(lower) ?? lower;
}

function foldLines(lines: readonly string[]): readonly string[] {
  return lines.reduce<string[]>((folded, line) => {
    if (!/^[ \t]/.test(line)) return [...folded, line];
    if (folded.length === 0) return malformed();
    return [...folded.slice(0, -1), `${folded[folded.length - 1] ?? ''} ${line.trim()}`];
  }, []);
}

function parseHeaderLine(line: string): readonly [string, string] {
  const colon = line.indexOf(':');
  if (colon < 1) return malformed();
  return [expandName(line.slice(0, colon)), line.slice(colon + 1).trim()];
}

function parseHeaders(lines: readonly string[]): SipHeaders {
  return foldLines(lines)
    .map(parseHeaderLine)
    .reduce<SipHeaders>((headers, [name, value]) => withAddedHeader(headers, name, value), {});
}

function parseHead(head: string): Head {
  const [first, ...rest] = head.split(LINE_BREAK).filter((line) => line !== '');
  if (first === undefined) return malformed();
  return { start: parseStartLine(first), headers: parseHeaders(rest) };
}

function assemble(head: Head, body: string): SipMessage {
  return { ...head.start, headers: head.headers, body };
}

export function parse(raw: string): SipMessage {
  const boundary = HEAD_END.exec(raw);
  if (boundary === null) return assemble(parseHead(raw), '');
  return assemble(parseHead(raw.slice(0, boundary.index)), raw.slice(boundary.index + boundary[0].length));
}

function canonicalName(name: string): string {
  const special = CANONICAL_NAMES.get(name);
  if (special !== undefined) return special;
  return name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('-');
}

function startLineText(message: SipMessage): string {
  return isResponse(message) ? `SIP/2.0 ${message.status} ${message.reason}` : `${message.method} ${message.uri} SIP/2.0`;
}

function headerLines(headers: SipHeaders): readonly string[] {
  return Object.entries(headers).flatMap(([name, values]) => values.map((value) => `${canonicalName(name)}: ${value}`));
}

export function serialize(message: SipMessage): string {
  const headers = withHeader(message.headers, 'content-length', String(byteLength(message.body)));
  return [startLineText(message), ...headerLines(headers), '', message.body].join('\r\n');
}

function contentLength(headers: SipHeaders): number {
  const value = headerValue(headers, 'content-length');
  if (value === undefined) return 0;
  return DIGITS.test(value) ? Number(value) : malformed();
}

function takeBytes(text: string, length: number): string | undefined {
  const bytes = encoder.encode(text);
  return bytes.length < length ? undefined : decoder.decode(bytes.subarray(0, length));
}

function nextFrame(buffer: string): Frame | undefined {
  const boundary = HEAD_END.exec(buffer);
  if (boundary === null) return undefined;
  const head = parseHead(buffer.slice(0, boundary.index));
  const bodyStart = boundary.index + boundary[0].length;
  const body = takeBytes(buffer.slice(bodyStart), contentLength(head.headers));
  if (body === undefined) return undefined;
  return { message: assemble(head, body), rest: buffer.slice(bodyStart + body.length) };
}

function drain(buffer: string, messages: SipMessage[]): { readonly messages: readonly SipMessage[]; readonly rest: string } {
  const stripped = buffer.replace(LEADING_BREAKS, '');
  const frame = nextFrame(stripped);
  if (frame === undefined) return { messages, rest: stripped };
  messages.push(frame.message);
  return drain(frame.rest, messages);
}

export function extractMessages(buffer: string): { readonly messages: readonly SipMessage[]; readonly rest: string } {
  return drain(buffer, []);
}

function parameterEntries(segments: readonly string[]): Readonly<Record<string, string>> {
  const entries = segments
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '')
    .map((segment): readonly [string, string] => {
      const equals = segment.indexOf('=');
      if (equals < 0) return [segment.toLowerCase(), ''];
      return [segment.slice(0, equals).trim().toLowerCase(), segment.slice(equals + 1).trim()];
    });
  return Object.fromEntries(entries);
}

export function parseParameters(value: string): Readonly<Record<string, string>> {
  return parameterEntries(value.split(';').slice(1));
}

function parseHostPort(hostPort: string): Pick<SipUri, 'host' | 'port'> {
  const match = HOST_PORT.exec(hostPort);
  if (match === null) return malformed();
  const host = match[1] ?? '';
  if (match[2] === undefined) return { host };
  const port = Number(match[2]);
  return port > MAX_PORT ? malformed() : { host, port };
}

function splitUserInfo(main: string): { readonly user?: string; readonly hostPort: string } {
  const at = main.lastIndexOf('@');
  if (at < 0) return { hostPort: main };
  return { user: main.slice(0, at).split(':')[0] ?? '', hostPort: main.slice(at + 1) };
}

export function parseUri(uri: string): SipUri {
  const scheme = URI_SCHEME.exec(uri);
  if (scheme === null) return malformed();
  const [main = '', ...segments] = (scheme[2] ?? '').split('?')[0]?.split(';') ?? [];
  const { user, hostPort } = splitUserInfo(main);
  return {
    scheme: scheme[1] ?? '',
    ...(user === undefined ? {} : { user }),
    ...parseHostPort(hostPort),
    parameters: parameterEntries(segments)
  };
}
