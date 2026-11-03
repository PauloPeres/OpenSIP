import { describe, expect, it } from 'vitest';
import {
  MalformedSipMessageError,
  extractMessages,
  headerValue,
  headerValues,
  isResponse,
  parse,
  parseParameters,
  parseStatusLine,
  parseUri,
  serialize,
  withAddedHeader,
  withHeader
} from '../../src/core/sip/message';
import type { SipMessage, SipRequest, SipResponse } from '../../src/core/sip/message';

const invite = (extra = '', body = ''): string =>
  `INVITE sip:bob@example.com SIP/2.0\r\nVia: SIP/2.0/TCP h:5060;branch=z9hG4bKx\r\nCall-ID: abc\r\n${extra}Content-Length: ${new TextEncoder().encode(body).length}\r\n\r\n${body}`;

const asRequest = (m: SipMessage): SipRequest => {
  if (m.kind !== 'request') throw new Error('expected request');
  return m;
};
const asResponse = (m: SipMessage): SipResponse => {
  if (m.kind !== 'response') throw new Error('expected response');
  return m;
};

describe('parse', () => {
  it('parses a request with headers and body', () => {
    const msg = asRequest(parse(invite('', 'v=0')));
    expect(msg.kind).toBe('request');
    expect(msg.method).toBe('INVITE');
    expect(msg.uri).toBe('sip:bob@example.com');
    expect(msg.headers).toEqual({
      via: ['SIP/2.0/TCP h:5060;branch=z9hG4bKx'],
      'call-id': ['abc'],
      'content-length': ['3']
    });
    expect(msg.body).toBe('v=0');
  });

  it('parses a response', () => {
    const msg = asResponse(parse('SIP/2.0 180 Ringing\r\nCall-ID: abc\r\n\r\n'));
    expect(msg.kind).toBe('response');
    expect(msg.status).toBe(180);
    expect(msg.reason).toBe('Ringing');
    expect(msg.body).toBe('');
  });

  it('accepts bare LF line endings', () => {
    const msg = asRequest(parse('OPTIONS sip:a@b SIP/2.0\nCall-ID: x\nCSeq: 1 OPTIONS\n\nbody'));
    expect(msg.headers).toEqual({ 'call-id': ['x'], cseq: ['1 OPTIONS'] });
    expect(msg.body).toBe('body');
  });

  it('accepts mixed line endings and a message without a blank line', () => {
    expect(asRequest(parse('BYE sip:a@b SIP/2.0\r\nCall-ID: x\n\r\n')).headers).toEqual({ 'call-id': ['x'] });
    const bare = asRequest(parse('BYE sip:a@b SIP/2.0\r\nCall-ID: x\r\n'));
    expect(bare.headers).toEqual({ 'call-id': ['x'] });
    expect(bare.body).toBe('');
    expect(asRequest(parse('BYE sip:a@b SIP/2.0')).headers).toEqual({});
  });

  it('keeps blank-line separators out of the body and the body untouched', () => {
    expect(asRequest(parse('BYE sip:a@b SIP/2.0\r\n\r\nline1\r\n\r\nline2')).body).toBe('line1\r\n\r\nline2');
  });

  it('joins continuation lines with a single space', () => {
    const msg = asRequest(parse('INVITE sip:a@b SIP/2.0\r\nSubject: I know you\r\n\t\t  are there\r\n   now\r\nCall-ID: x\r\n\r\n'));
    expect(headerValue(msg.headers, 'subject')).toBe('I know you are there now');
    expect(headerValue(msg.headers, 'call-id')).toBe('x');
  });

  it('rejects a continuation with nothing to continue', () => {
    expect(() => parse('INVITE sip:a@b SIP/2.0\r\n folded\r\n\r\n')).toThrow(MalformedSipMessageError);
  });

  it('accumulates repeated headers in arrival order', () => {
    const msg = asRequest(parse('INVITE sip:a@b SIP/2.0\r\nVia: one\r\nCall-ID: x\r\nVia: two\r\nv: three\r\n\r\n'));
    expect(msg.headers.via).toEqual(['one', 'two', 'three']);
  });

  it('trims header values and lowercases names', () => {
    const msg = asRequest(parse('INVITE sip:a@b SIP/2.0\r\nCALL-id :   spaced value  \r\n\r\n'));
    expect(msg.headers).toEqual({ 'call-id': ['spaced value'] });
  });

  it('keeps colons inside header values', () => {
    const msg = asRequest(parse('INVITE sip:a@b SIP/2.0\r\nContact: <sip:a@b:5060>\r\n\r\n'));
    expect(msg.headers.contact).toEqual(['<sip:a@b:5060>']);
  });

  it.each([
    ['i', 'call-id'],
    ['m', 'contact'],
    ['f', 'from'],
    ['t', 'to'],
    ['v', 'via'],
    ['c', 'content-type'],
    ['l', 'content-length'],
    ['s', 'subject'],
    ['k', 'supported']
  ])('expands the compact form %s to %s', (compact, full) => {
    const msg = asRequest(parse(`INVITE sip:a@b SIP/2.0\r\n${compact}: value\r\n\r\n`));
    expect(msg.headers).toEqual({ [full]: ['value'] });
    const upper = asRequest(parse(`INVITE sip:a@b SIP/2.0\r\n${compact.toUpperCase()}: value\r\n\r\n`));
    expect(upper.headers).toEqual({ [full]: ['value'] });
  });

  it('does not treat longer names as compact forms', () => {
    const msg = asRequest(parse('INVITE sip:a@b SIP/2.0\r\nconstructor: x\r\nii: y\r\n\r\n'));
    expect(Object.keys(msg.headers)).toEqual(['constructor', 'ii']);
  });

  it.each([
    'garbage',
    'INVITE sip:a@b',
    'INVITE sip:a@b SIP/3.0',
    'INVITE  SIP/2.0',
    'INVITE sip:a@b SIP/2.0 extra',
    'SIP/2.0',
    'SIP/2.0 abc OK',
    'SIP/2.0 20 OK',
    'SIP/2.0 2000 OK',
    'SIP/3.0 200 OK',
    ' INVITE sip:a@b SIP/2.0'
  ])('rejects the malformed start line %j', (line) => {
    expect(() => parse(`${line}\r\nCall-ID: x\r\n\r\n`)).toThrow(MalformedSipMessageError);
  });

  it('rejects a header line without a name or colon', () => {
    expect(() => parse('INVITE sip:a@b SIP/2.0\r\nno colon here\r\n\r\n')).toThrow(MalformedSipMessageError);
    expect(() => parse('INVITE sip:a@b SIP/2.0\r\n: nameless\r\n\r\n')).toThrow(MalformedSipMessageError);
  });

  it('rejects empty input with a short identifier', () => {
    expect(() => parse('')).toThrow(MalformedSipMessageError);
    expect(() => parse('')).toThrowError('malformed-sip-message');
    try {
      parse('');
    } catch (error) {
      expect((error as Error).name).toBe('MalformedSipMessageError');
    }
  });

  it.each([100, 200, 404, 699])('accepts status %i', (status) => {
    expect(asResponse(parse(`SIP/2.0 ${status} X\r\n\r\n`)).status).toBe(status);
  });

  it.each([99, 700, 0, 999])('rejects status %i', (status) => {
    expect(() => parse(`SIP/2.0 ${String(status).padStart(3, '0')} X\r\n\r\n`)).toThrow(MalformedSipMessageError);
  });
});

describe('parseStatusLine', () => {
  it('parses status and reason', () => {
    expect(parseStatusLine('SIP/2.0 407 Proxy Authentication Required')).toEqual({
      status: 407,
      reason: 'Proxy Authentication Required'
    });
  });

  it('allows an empty reason with or without the trailing space', () => {
    expect(parseStatusLine('SIP/2.0 200')).toEqual({ status: 200, reason: '' });
    expect(parseStatusLine('SIP/2.0 200 ')).toEqual({ status: 200, reason: '' });
  });

  it('enforces the 100 to 699 range exactly', () => {
    expect(parseStatusLine('SIP/2.0 100 a').status).toBe(100);
    expect(parseStatusLine('SIP/2.0 699 a').status).toBe(699);
    expect(() => parseStatusLine('SIP/2.0 099 a')).toThrow(MalformedSipMessageError);
    expect(() => parseStatusLine('SIP/2.0 700 a')).toThrow(MalformedSipMessageError);
  });

  it('rejects a line that is not a status line', () => {
    expect(() => parseStatusLine('INVITE sip:a SIP/2.0')).toThrow(MalformedSipMessageError);
    expect(() => parseStatusLine('SIP/2.0 2x0 OK')).toThrow(MalformedSipMessageError);
    expect(() => parseStatusLine('xSIP/2.0 200 OK')).toThrow(MalformedSipMessageError);
  });
});

describe('serialize', () => {
  it('writes CRLF line endings, canonical names and a Content-Length', () => {
    const text = serialize({
      kind: 'request',
      method: 'REGISTER',
      uri: 'sip:example.com',
      headers: { via: ['SIP/2.0/TCP h;branch=z9hG4bKx'], 'call-id': ['abc'], cseq: ['1 REGISTER'], 'max-forwards': ['70'] },
      body: ''
    });
    expect(text).toBe(
      'REGISTER sip:example.com SIP/2.0\r\n' +
        'Via: SIP/2.0/TCP h;branch=z9hG4bKx\r\n' +
        'Call-ID: abc\r\n' +
        'CSeq: 1 REGISTER\r\n' +
        'Max-Forwards: 70\r\n' +
        'Content-Length: 0\r\n\r\n'
    );
  });

  it('serializes a response status line', () => {
    expect(serialize({ kind: 'response', status: 200, reason: 'OK', headers: {}, body: '' })).toBe(
      'SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n'
    );
  });

  it('emits one line per repeated header value', () => {
    const text = serialize({ kind: 'response', status: 180, reason: 'Ringing', headers: { via: ['a', 'b'] }, body: '' });
    expect(text).toContain('Via: a\r\nVia: b\r\n');
  });

  it('overrides a stale Content-Length with the body byte length', () => {
    const text = serialize({
      kind: 'request',
      method: 'MESSAGE',
      uri: 'sip:a@b',
      headers: { 'content-length': ['999'], 'www-authenticate': ['x'] },
      body: 'héllo'
    });
    expect(text).toBe('MESSAGE sip:a@b SIP/2.0\r\nContent-Length: 6\r\nWWW-Authenticate: x\r\n\r\nhéllo');
  });

  it('title-cases other header names', () => {
    const text = serialize({ kind: 'request', method: 'BYE', uri: 'sip:a@b', headers: { 'x-custom-thing': ['1'] }, body: '' });
    expect(text).toContain('X-Custom-Thing: 1\r\n');
  });

  it('round-trips through parse', () => {
    const original: SipRequest = {
      kind: 'request',
      method: 'INVITE',
      uri: 'sip:bob@example.com',
      headers: { via: ['v'], 'call-id': ['c'], 'content-length': ['4'] },
      body: 'v=0\n'
    };
    expect(parse(serialize(original))).toEqual(original);
  });
});

describe('header helpers', () => {
  const headers = { via: ['a', 'b'], 'call-id': ['c'] };

  it('looks values up case-insensitively', () => {
    expect(headerValue(headers, 'VIA')).toBe('a');
    expect(headerValues(headers, 'Via')).toEqual(['a', 'b']);
    expect(headerValue(headers, 'Call-ID')).toBe('c');
  });

  it('returns undefined and [] for missing names, including inherited keys', () => {
    expect(headerValue(headers, 'route')).toBeUndefined();
    expect(headerValues(headers, 'route')).toEqual([]);
    expect(headerValues(headers, 'constructor')).toEqual([]);
    expect(headerValue(headers, 'toString')).toBeUndefined();
  });

  it('replaces with withHeader without mutating the input', () => {
    const next = withHeader(headers, 'Via', 'z');
    expect(next).toEqual({ via: ['z'], 'call-id': ['c'] });
    expect(headers.via).toEqual(['a', 'b']);
    expect(withHeader(headers, 'Route', 'r')).toEqual({ via: ['a', 'b'], 'call-id': ['c'], route: ['r'] });
  });

  it('appends with withAddedHeader without mutating the input', () => {
    expect(withAddedHeader(headers, 'VIA', 'z')).toEqual({ via: ['a', 'b', 'z'], 'call-id': ['c'] });
    expect(withAddedHeader(headers, 'Route', 'r')).toEqual({ via: ['a', 'b'], 'call-id': ['c'], route: ['r'] });
    expect(headers.via).toEqual(['a', 'b']);
  });

  it('discriminates responses', () => {
    expect(isResponse(parse('SIP/2.0 200 OK\r\n\r\n'))).toBe(true);
    expect(isResponse(parse('BYE sip:a@b SIP/2.0\r\n\r\n'))).toBe(false);
  });
});

describe('extractMessages', () => {
  const ok = 'SIP/2.0 200 OK\r\nCall-ID: a\r\nContent-Length: 0\r\n\r\n';

  it('returns an empty result for an empty buffer', () => {
    expect(extractMessages('')).toEqual({ messages: [], rest: '' });
  });

  it('returns a complete message and clears the rest', () => {
    const result = extractMessages(ok);
    expect(result.messages).toHaveLength(1);
    expect(asResponse(result.messages[0] as SipMessage).status).toBe(200);
    expect(result.rest).toBe('');
  });

  it('leaves a header block without a terminating blank line in rest', () => {
    const partial = 'SIP/2.0 200 OK\r\nCall-ID: a\r\n';
    expect(extractMessages(partial)).toEqual({ messages: [], rest: partial });
    const almost = 'SIP/2.0 200 OK\r\nCall-ID: a\r\n\r';
    expect(extractMessages(almost)).toEqual({ messages: [], rest: almost });
  });

  it('leaves a message whose body is short in rest, entirely', () => {
    const partial = 'SIP/2.0 200 OK\r\nContent-Length: 5\r\n\r\nabcd';
    expect(extractMessages(partial)).toEqual({ messages: [], rest: partial });
  });

  it('completes a message when exactly Content-Length bytes are present', () => {
    const exact = 'SIP/2.0 200 OK\r\nContent-Length: 5\r\n\r\nabcde';
    const result = extractMessages(exact);
    expect(result.messages).toHaveLength(1);
    expect((result.messages[0] as SipMessage).body).toBe('abcde');
    expect(result.rest).toBe('');
  });

  it('leaves extra bytes after the body in rest', () => {
    const result = extractMessages('SIP/2.0 200 OK\r\nContent-Length: 5\r\n\r\nabcdeXY');
    expect((result.messages[0] as SipMessage).body).toBe('abcde');
    expect(result.rest).toBe('XY');
  });

  it('treats Content-Length 0 as an empty body', () => {
    const result = extractMessages(`${ok}tail`);
    expect(result.messages).toHaveLength(1);
    expect((result.messages[0] as SipMessage).body).toBe('');
    expect(result.rest).toBe('tail');
  });

  it('treats a missing Content-Length as a zero-length body', () => {
    const result = extractMessages('SIP/2.0 200 OK\r\nCall-ID: a\r\n\r\nSIP/2.0 180 Ringing\r\n\r\n');
    expect(result.messages.map((m) => asResponse(m).status)).toEqual([200, 180]);
    expect(result.rest).toBe('');
  });

  it('honours the compact Content-Length form', () => {
    const result = extractMessages('SIP/2.0 200 OK\r\nl: 3\r\n\r\nabcdef');
    expect((result.messages[0] as SipMessage).body).toBe('abc');
    expect(result.rest).toBe('def');
  });

  it('returns several concatenated messages in order', () => {
    const a = invite('', 'one');
    const b = ok;
    const c = invite('', 'three!');
    const result = extractMessages(a + b + c);
    expect(result.messages.map((m) => (isResponse(m) ? m.status : asRequest(m).method))).toEqual(['INVITE', 200, 'INVITE']);
    expect(result.messages.map((m) => m.body)).toEqual(['one', '', 'three!']);
    expect(result.rest).toBe('');
  });

  it('returns completed messages and keeps the trailing partial one', () => {
    const partial = 'SIP/2.0 180 Ringing\r\nContent-Length: 4\r\n\r\nab';
    const result = extractMessages(ok + partial);
    expect(result.messages).toHaveLength(1);
    expect(result.rest).toBe(partial);
  });

  it('is incremental when a message arrives byte by byte', () => {
    const wire = invite('', 'hello');
    let buffer = '';
    const seen: SipMessage[] = [];
    for (const char of wire) {
      const result = extractMessages(buffer + char);
      seen.push(...result.messages);
      buffer = result.rest;
    }
    expect(seen).toHaveLength(1);
    expect((seen[0] as SipMessage).body).toBe('hello');
    expect(buffer).toBe('');
  });

  it('skips leading CRLF keep-alives', () => {
    const result = extractMessages(`\r\n\r\n\r\n${ok}\r\n\r\n`);
    expect(result.messages).toHaveLength(1);
    expect(result.rest).toBe('');
  });

  it('skips keep-alives between messages and drops a lone keep-alive', () => {
    expect(extractMessages(`${ok}\r\n\r\n${ok}`).messages).toHaveLength(2);
    expect(extractMessages('\r\n\r\n')).toEqual({ messages: [], rest: '' });
  });

  it('measures Content-Length in UTF-8 bytes', () => {
    const body = 'héllo €';
    const bytes = new TextEncoder().encode(body).length;
    expect(bytes).toBe(10);
    const wire = `SIP/2.0 200 OK\r\nContent-Length: ${bytes}\r\n\r\n${body}`;
    const result = extractMessages(wire);
    expect((result.messages[0] as SipMessage).body).toBe(body);
    expect(result.rest).toBe('');
    const short = `SIP/2.0 200 OK\r\nContent-Length: ${bytes + 1}\r\n\r\n${body}`;
    expect(extractMessages(short)).toEqual({ messages: [], rest: short });
  });

  it('propagates a malformed header block instead of dropping it', () => {
    expect(() => extractMessages('NONSENSE\r\nCall-ID: a\r\n\r\n')).toThrow(MalformedSipMessageError);
    expect(() => extractMessages('SIP/2.0 200 OK\r\nbad header\r\n\r\n')).toThrow(MalformedSipMessageError);
  });

  it('rejects an unparsable Content-Length', () => {
    for (const value of ['abc', '-1', '1.5', '', '1 2']) {
      expect(() => extractMessages(`SIP/2.0 200 OK\r\nContent-Length: ${value}\r\n\r\n`)).toThrow(MalformedSipMessageError);
    }
  });

  it('accepts bare LF framing', () => {
    const result = extractMessages('SIP/2.0 200 OK\nContent-Length: 2\n\nhiSIP/2.0 180 R\n\n');
    expect(result.messages.map((m) => m.body)).toEqual(['hi', '']);
  });
});

describe('parseParameters', () => {
  it('drops the leading value and returns flags as empty strings', () => {
    expect(parseParameters('SIP/2.0/TCP h:5060;branch=z9hG4bKx;rport')).toEqual({ branch: 'z9hG4bKx', rport: '' });
  });

  it('returns nothing when there are no parameters', () => {
    expect(parseParameters('SIP/2.0/TCP h:5060')).toEqual({});
    expect(parseParameters('')).toEqual({});
  });

  it('trims, lowercases names, keeps value case, and splits on the first =', () => {
    expect(parseParameters('x ; Tag = AbC ;; q=a=b ')).toEqual({ tag: 'AbC', q: 'a=b' });
  });
});

describe('parseUri', () => {
  it('parses user, host, port and parameters', () => {
    expect(parseUri('sip:alice@example.com:5070;transport=tcp;lr')).toEqual({
      scheme: 'sip',
      user: 'alice',
      host: 'example.com',
      port: 5070,
      parameters: { transport: 'tcp', lr: '' }
    });
  });

  it('parses a bare host without user or port', () => {
    const uri = parseUri('sip:example.com');
    expect(uri).toEqual({ scheme: 'sip', host: 'example.com', parameters: {} });
    expect('user' in uri).toBe(false);
    expect('port' in uri).toBe(false);
  });

  it('drops the password and keeps sips as the scheme', () => {
    expect(parseUri('sips:alice:secret@host:5061')).toEqual({
      scheme: 'sips',
      user: 'alice',
      host: 'host',
      port: 5061,
      parameters: {}
    });
  });

  it('strips URI headers', () => {
    expect(parseUri('sip:a@host?subject=x;y=1')).toEqual({ scheme: 'sip', user: 'a', host: 'host', parameters: {} });
  });

  it('handles IPv6 hosts', () => {
    expect(parseUri('sip:a@[::1]:5060')).toEqual({ scheme: 'sip', user: 'a', host: '[::1]', port: 5060, parameters: {} });
    expect(parseUri('sip:[2001:db8::1]')).toEqual({ scheme: 'sip', host: '[2001:db8::1]', parameters: {} });
  });

  it('accepts the port boundaries', () => {
    expect(parseUri('sip:h:0').port).toBe(0);
    expect(parseUri('sip:h:65535').port).toBe(65535);
  });

  it.each(['', 'nonsense', 'sip:', 'sip:@', 'sip:a@', 'sip:h:abc', 'sip:h:65536', ':user@host', '1sip:h'])(
    'rejects %j',
    (uri) => {
      expect(() => parseUri(uri)).toThrow(MalformedSipMessageError);
    }
  );
});
