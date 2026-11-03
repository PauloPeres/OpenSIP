import { describe, expect, it } from 'vitest';
import {
  REDACTION,
  redactDetails,
  redactSipMessage,
  redactValue
} from '../../src/core/diagnostics/redact';

const PASSWORD = 's3cr3t-P@ssw0rd';
const HASH = '6629fae49393a05397450978507c4ef1';
const R = REDACTION;

const AUTH =
  'Authorization: Digest username="1001", realm="asterisk", nonce="1a2b3c4d5e6f", ' +
  'uri="sip:198.51.100.248", response="6629fae49393a05397450978507c4ef1", algorithm=MD5, ' +
  'cnonce="0a4f113b", qop=auth, nc=00000001, opaque="5ccc069c403ebaf9f0171e9517f40e41"';

const register = (authLine: string, tail = 'Content-Length: 0\r\n\r\n'): string =>
  [
    'REGISTER sip:198.51.100.248 SIP/2.0',
    'Via: SIP/2.0/UDP 10.0.0.5:5060;branch=z9hG4bK776asdhds',
    'CSeq: 2 REGISTER',
    authLine,
    tail
  ].join('\r\n');

describe('REDACTION', () => {
  it('is the bracketed marker', () => {
    expect(REDACTION).toBe('[redacted]');
  });
});

describe('redactSipMessage digest credentials', () => {
  it('replaces response, nonce, cnonce and opaque but keeps username, realm, uri', () => {
    const out = redactSipMessage(register(AUTH));
    expect(out).toBe(
      register(
        'Authorization: Digest username="1001", realm="asterisk", nonce="[redacted]", ' +
          'uri="sip:198.51.100.248", response="[redacted]", algorithm=MD5, ' +
          'cnonce="[redacted]", qop=auth, nc=00000001, opaque="[redacted]"'
      )
    );
    expect(out).not.toContain(HASH);
  });

  it('handles a lower-case header name and Proxy-Authorization', () => {
    expect(redactSipMessage('authorization: Digest username="a", response="abc"\r\n\r\n')).toBe(
      'authorization: Digest username="a", response="[redacted]"\r\n\r\n'
    );
    expect(redactSipMessage('Proxy-Authorization: Digest realm="r", RESPONSE="abc"')).toBe(
      'Proxy-Authorization: Digest realm="r", RESPONSE="[redacted]"'
    );
  });

  it('handles odd spacing around equals and unquoted values', () => {
    expect(
      redactSipMessage('Authorization: Digest username = "u" ,response  =  "abc" , nonce= xyz,qop=auth')
    ).toBe('Authorization: Digest username = "u" ,response  =  "[redacted]" , nonce= [redacted],qop=auth');
  });

  it('handles a folded header continued on the next line', () => {
    const folded =
      'Authorization: Digest username="u",\r\n realm="r",\r\n\tresponse="deadbeefdeadbeefdeadbeefdeadbeef"';
    const out = redactSipMessage(folded);
    expect(out).not.toContain('deadbeef');
    expect(out).toBe('Authorization: Digest username="u", realm="r", response="[redacted]"');
  });

  it('is not fooled by a quoted value containing a comma or a look-alike parameter', () => {
    expect(
      redactSipMessage('Authorization: Digest realm="a, response=zzz", response="real", nonce="n,1"')
    ).toBe('Authorization: Digest realm="a, response=zzz", response="[redacted]", nonce="[redacted]"');
  });

  it('redacts challenge headers nonce and opaque but keeps the realm', () => {
    expect(
      redactSipMessage(
        'WWW-Authenticate: Digest realm="asterisk", nonce="abc", opaque="def", algorithm=MD5'
      )
    ).toBe('WWW-Authenticate: Digest realm="asterisk", nonce="[redacted]", opaque="[redacted]", algorithm=MD5');
    expect(redactSipMessage('Proxy-Authenticate: Digest realm="p", nonce="abc"')).toBe(
      'Proxy-Authenticate: Digest realm="p", nonce="[redacted]"'
    );
  });

  it('redacts Authentication-Info hashes', () => {
    expect(redactSipMessage('Authentication-Info: nextnonce="n", rspauth="h", qop=auth')).toBe(
      'Authentication-Info: nextnonce="[redacted]", rspauth="[redacted]", qop=auth'
    );
  });
});

describe('redactSipMessage fails closed', () => {
  it('drops the whole value of a header it cannot parse', () => {
    const out = redactSipMessage(`Authorization: ??? ${PASSWORD} ;;; response`);
    expect(out).toBe(`Authorization: ${R}`);
    expect(out).not.toContain(PASSWORD);
  });

  it('drops a Basic credential', () => {
    const out = redactSipMessage('Proxy-Authorization: Basic dXNlcjpzM2NyM3Q=\r\nCSeq: 1 INVITE');
    expect(out).toBe(`Proxy-Authorization: ${R}\r\nCSeq: 1 INVITE`);
  });

  it('drops a value with an unterminated quote', () => {
    expect(redactSipMessage(`Authorization: Digest response="${HASH}`)).toBe(`Authorization: ${R}`);
  });

  it('drops a multi-challenge value it does not understand', () => {
    expect(redactSipMessage('WWW-Authenticate: Digest realm="a", nonce="n", Basic realm="b"')).toBe(
      `WWW-Authenticate: ${R}`
    );
  });
});

describe('redactSipMessage bodies', () => {
  const sdp = 'v=0\r\no=- 1 1 IN IP4 10.0.0.5\r\ns=-\r\n';

  it('keeps an SDP body untouched', () => {
    const msg = `INVITE sip:b SIP/2.0\r\nContent-Type: application/sdp\r\nContent-Length: ${sdp.length}\r\n\r\n${sdp}`;
    expect(redactSipMessage(msg)).toBe(msg);
  });

  it('keeps SDP when the type is upper case, short form or has parameters', () => {
    expect(redactSipMessage(`X: 1\r\nContent-Type: Application/SDP; charset=utf-8\r\n\r\n${sdp}`)).toContain('v=0');
    expect(redactSipMessage(`X: 1\r\nc: application/sdp\r\n\r\n${sdp}`)).toContain('v=0');
  });

  it('replaces a non-SDP body and keeps the headers', () => {
    const msg = `MESSAGE sip:b SIP/2.0\r\nContent-Type: text/plain\r\nContent-Length: 20\r\n\r\npassword ${PASSWORD}`;
    const out = redactSipMessage(msg);
    expect(out).toBe(
      `MESSAGE sip:b SIP/2.0\r\nContent-Type: text/plain\r\nContent-Length: 20\r\n\r\n${R}`
    );
    expect(out).not.toContain(PASSWORD);
  });

  it('replaces a body that has no Content-Type', () => {
    expect(redactSipMessage(`MESSAGE sip:b SIP/2.0\nCSeq: 1 MESSAGE\n\nhello ${PASSWORD}`)).toBe(
      `MESSAGE sip:b SIP/2.0\nCSeq: 1 MESSAGE\n\n${R}`
    );
  });

  it('leaves a message with an empty body alone', () => {
    const msg = 'SIP/2.0 200 OK\r\nCSeq: 2 REGISTER\r\nContent-Length: 0\r\n\r\n';
    expect(redactSipMessage(msg)).toBe(msg);
  });

  it('leaves a message with no body separator alone', () => {
    expect(redactSipMessage('SIP/2.0 200 OK\r\nCSeq: 2 REGISTER')).toBe(
      'SIP/2.0 200 OK\r\nCSeq: 2 REGISTER'
    );
  });

  it('does not treat a header-looking body line as a header', () => {
    const msg = 'MESSAGE sip:b SIP/2.0\r\nContent-Type: text/plain\r\n\r\nAuthorization: Digest response="x"';
    expect(redactSipMessage(msg)).toBe(`MESSAGE sip:b SIP/2.0\r\nContent-Type: text/plain\r\n\r\n${R}`);
  });
});

describe('redactSipMessage leaves ordinary headers alone', () => {
  it('does not touch headers that merely mention response', () => {
    const msg = 'SIP/2.0 401 Unauthorized\r\nContact: <sip:a@b>;response=1\r\nUser-Agent: x nonce=1\r\n\r\n';
    expect(redactSipMessage(msg)).toBe(msg);
  });

  it('returns an empty string unchanged', () => {
    expect(redactSipMessage('')).toBe('');
  });
});

describe('redactValue', () => {
  it.each([
    ['password=hunter2', `password=${R}`],
    ['pwd=hunter2', `pwd=${R}`],
    ['secret=hunter2', `secret=${R}`],
    ['token=abc.def', `token=${R}`],
    ['PASSWORD = "hunter 2"', `PASSWORD = ${R}`],
    ['user=a&password=hunter2&x=1', `user=a&password=${R}&x=1`],
    ['pwd=a,next=1', `pwd=${R},next=1`]
  ])('masks assignment %s', (input, expected) => {
    expect(redactValue(input)).toBe(expected);
  });

  it('masks a bare 32-hex MD5 response, in any case', () => {
    expect(redactValue(HASH)).toBe(R);
    expect(redactValue(HASH.toUpperCase())).toBe(R);
    expect(redactValue(`bad ${HASH} here`)).toBe(`bad ${R} here`);
  });

  it('keeps other values', () => {
    expect(redactValue('udp')).toBe('udp');
    expect(redactValue('198.51.100.248')).toBe('198.51.100.248');
    expect(redactValue('abcdef0123456789abcdef012345678')).toBe('abcdef0123456789abcdef012345678');
    expect(redactValue(`${HASH}0`)).toBe(`${HASH}0`);
    expect(redactValue('')).toBe('');
  });
});

describe('redactDetails', () => {
  it('redacts every value and keeps the keys', () => {
    expect(redactDetails({ host: 'pbx.example.com', note: 'password=x', h: HASH })).toEqual({
      host: 'pbx.example.com',
      note: `password=${R}`,
      h: R
    });
  });

  it('returns an empty record for an empty one', () => {
    expect(redactDetails({})).toEqual({});
  });
});
