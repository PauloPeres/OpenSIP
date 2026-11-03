export const REDACTION = '[redacted]';

const SECRET_PARAMS: ReadonlySet<string> = new Set([
  'response',
  'nonce',
  'cnonce',
  'opaque',
  'nextnonce',
  'rspauth'
]);

const AUTH_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'www-authenticate',
  'proxy-authenticate',
  'authentication-info'
]);

const PARAM = String.raw`[A-Za-z][\w-]*\s*=\s*(?:"(?:[^"\\]|\\.)*"|[^\s,"]+)`;
// Only a Digest-style list of key=value pairs is understood; anything else fails closed.
const PARSEABLE = new RegExp(`^(?:digest\\s+)?${PARAM}(?:\\s*,\\s*${PARAM})*$`, 'i');
const PARAM_GLOBAL = /([A-Za-z][\w-]*)(\s*=\s*)("(?:[^"\\]|\\.)*"|[^\s,"]+)/g;
const HEADER = /^([^\s:]+)(\s*:\s*)([\s\S]*)$/;
const BODY_SEPARATOR = /\r?\n\r?\n/;
const FOLD = /\r?\n[ \t]+/g;
const CREDENTIAL_ASSIGNMENT = /\b(password|pwd|secret|token)(\s*=\s*)("[^"]*"|[^\s,;&]+)/gi;
const MD5_HEX = /\b[0-9a-f]{32}\b/gi;

function redactParam(match: string, key: string, sep: string, value: string): string {
  if (!SECRET_PARAMS.has(key.toLowerCase())) return match;
  return `${key}${sep}${value.startsWith('"') ? `"${REDACTION}"` : REDACTION}`;
}

function redactAuthValue(value: string): string {
  const unfolded = value.replace(FOLD, ' ').trim();
  if (!PARSEABLE.test(unfolded)) return REDACTION;
  return unfolded.replace(PARAM_GLOBAL, redactParam);
}

function redactHeader(header: string): string {
  const match = HEADER.exec(header);
  if (match === null) return header;
  const [, name = '', sep = '', value = ''] = match;
  return AUTH_HEADERS.has(name.toLowerCase()) ? `${name}${sep}${redactAuthValue(value)}` : header;
}

function groupHeaders(lines: readonly string[], eol: string): string[] {
  const groups: string[] = [];
  for (const line of lines) {
    const last = groups.length - 1;
    const continuation = /^[ \t]/.test(line) && last >= 0;
    if (continuation) groups[last] = `${groups[last] ?? ''}${eol}${line}`;
    else groups.push(line);
  }
  return groups;
}

const CONTENT_TYPE_NAMES: ReadonlySet<string> = new Set(['content-type', 'c']);

function contentType(headers: readonly string[]): string {
  for (const header of headers) {
    const match = HEADER.exec(header);
    if (CONTENT_TYPE_NAMES.has((match?.[1] ?? '').toLowerCase())) return match?.[3] ?? '';
  }
  return '';
}

function isSdp(headers: readonly string[]): boolean {
  const mediaType = contentType(headers).split(';')[0] ?? '';
  return mediaType.trim().toLowerCase() === 'application/sdp';
}

function redactBody(body: string, keep: boolean): string {
  return body === '' || keep ? body : REDACTION;
}

/** Strips secrets from a raw SIP message before it is ever stored or displayed. */
export function redactSipMessage(raw: string): string {
  const separator = BODY_SEPARATOR.exec(raw);
  const head = separator === null ? raw : raw.slice(0, separator.index);
  const tail = separator === null ? '' : raw.slice(separator.index + separator[0].length);
  const eol = head.includes('\r\n') ? '\r\n' : '\n';
  const headers = groupHeaders(head.split(eol), eol);
  const redactedHead = headers.map(redactHeader).join(eol);
  if (separator === null) return redactedHead;
  return `${redactedHead}${separator[0]}${redactBody(tail, isSdp(headers))}`;
}

/** Strips secrets from an arbitrary value used as a log detail. */
export function redactValue(value: string): string {
  return value
    .replace(CREDENTIAL_ASSIGNMENT, `$1$2${REDACTION}`)
    .replace(MD5_HEX, REDACTION);
}

export function redactDetails(
  details: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(details)) out[key] = redactValue(value);
  return out;
}
