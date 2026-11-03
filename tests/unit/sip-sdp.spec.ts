import { describe, expect, it } from 'vitest';
import { MalformedSdpError, NoCommonCodecError, UnknownPayloadTypeError, buildOffer, holdDirection, negotiate, parseSdp, resumeDirection } from '../../src/core/sip/sdp';
import type { SdpMedia, SessionDescription } from '../../src/core/sip/sdp';

const base = { address: '192.168.1.20', port: 40000, sessionId: '12345' };
const lines = (sdp: string): string[] => sdp.split('\r\n');

const asterisk = [
  'v=0',
  'o=root 1844751 1844752 IN IP4 10.0.0.5',
  's=Asterisk PBX 20.5.0',
  'c=IN IP4 10.0.0.5',
  't=0 0',
  'm=audio 14086 RTP/AVP 8 0 101',
  'a=rtpmap:8 PCMA/8000',
  'a=rtpmap:0 PCMU/8000',
  'a=rtpmap:101 telephone-event/8000',
  'a=fmtp:101 0-16',
  'a=ptime:20',
  'a=maxptime:150',
  'a=sendrecv',
  ''
].join('\r\n');

const kamailio = [
  'v=0',
  'o=- 3902 3902 IN IP4 203.0.113.9',
  's=-',
  't=0 0',
  'm=audio 30000 RTP/AVP 0',
  'c=IN IP4 203.0.113.10',
  'a=recvonly',
  ''
].join('\n');

describe('buildOffer', () => {
  const offer = buildOffer(base);

  it('uses CRLF line endings and ends with one', () => {
    expect(offer.endsWith('\r\n')).toBe(true);
    expect(offer.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  it('writes the exact session header', () => {
    expect(lines(offer).slice(0, 5)).toEqual([
      'v=0',
      'o=- 12345 12345 IN IP4 192.168.1.20',
      's=-',
      'c=IN IP4 192.168.1.20',
      't=0 0'
    ]);
  });

  it('advertises PCMU, PCMA and telephone-event 101 on the given port', () => {
    expect(lines(offer)).toContain('m=audio 40000 RTP/AVP 0 8 101');
    expect(lines(offer)).toContain('a=rtpmap:0 PCMU/8000');
    expect(lines(offer)).toContain('a=rtpmap:8 PCMA/8000');
    expect(lines(offer)).toContain('a=rtpmap:101 telephone-event/8000');
    expect(lines(offer)).toContain('a=fmtp:101 0-16');
  });

  it('carries ptime 20 and defaults to sendrecv', () => {
    expect(lines(offer)).toContain('a=ptime:20');
    expect(lines(offer)).toContain('a=sendrecv');
  });

  it('honours custom payload types and direction', () => {
    const custom = buildOffer({ ...base, payloadTypes: [8], direction: 'recvonly' });
    expect(lines(custom)).toContain('m=audio 40000 RTP/AVP 8 101');
    expect(lines(custom)).toContain('a=recvonly');
    expect(custom).not.toContain('PCMU');
    expect(custom).not.toContain('a=sendrecv');
  });

  it('round-trips through parseSdp', () => {
    expect(parseSdp(offer)).toEqual({
      origin: { username: '-', sessionId: '12345', version: '12345', address: '192.168.1.20' },
      connectionAddress: '192.168.1.20',
      audio: {
        port: 40000,
        payloadTypes: [0, 8, 101],
        direction: 'sendrecv',
        rtpmap: { 0: 'PCMU/8000', 8: 'PCMA/8000', 101: 'telephone-event/8000' }
      }
    });
  });
});

describe('parseSdp', () => {
  it('parses an Asterisk-shaped answer', () => {
    const sdp = parseSdp(asterisk);
    expect(sdp.origin).toEqual({ username: 'root', sessionId: '1844751', version: '1844752', address: '10.0.0.5' });
    expect(sdp.connectionAddress).toBe('10.0.0.5');
    expect(sdp.audio.port).toBe(14086);
    expect(sdp.audio.payloadTypes).toEqual([8, 0, 101]);
    expect(sdp.audio.direction).toBe('sendrecv');
    expect(sdp.audio.rtpmap).toEqual({ 8: 'PCMA/8000', 0: 'PCMU/8000', 101: 'telephone-event/8000' });
  });

  it('parses a Kamailio-shaped body with bare LF and a media-level c= line', () => {
    const sdp = parseSdp(kamailio);
    expect(sdp.connectionAddress).toBe('203.0.113.10');
    expect(sdp.audio.port).toBe(30000);
    expect(sdp.audio.payloadTypes).toEqual([0]);
    expect(sdp.audio.direction).toBe('recvonly');
    expect(sdp.audio.rtpmap).toEqual({});
  });

  it.each(['sendrecv', 'sendonly', 'recvonly', 'inactive'] as const)('reads a=%s', (direction) => {
    const sdp = parseSdp(`v=0\r\nc=IN IP4 1.2.3.4\r\nm=audio 4000 RTP/AVP 0\r\na=${direction}\r\n`);
    expect(sdp.audio.direction).toBe(direction);
  });

  it('defaults to sendrecv when no direction attribute is present', () => {
    expect(parseSdp('v=0\r\nc=IN IP4 1.2.3.4\r\nm=audio 4000 RTP/AVP 0\r\n').audio.direction).toBe('sendrecv');
  });

  it('keeps a declined stream (port 0)', () => {
    const sdp = parseSdp('v=0\r\nc=IN IP4 1.2.3.4\r\nm=audio 0 RTP/AVP 0\r\n');
    expect(sdp.audio.port).toBe(0);
  });

  it('ignores a video section after the audio section', () => {
    const sdp = parseSdp(
      'v=0\r\nc=IN IP4 1.2.3.4\r\nm=audio 4000 RTP/AVP 0\r\nm=video 5000 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=sendonly\r\n'
    );
    expect(sdp.audio.payloadTypes).toEqual([0]);
    expect(sdp.audio.rtpmap).toEqual({});
    expect(sdp.audio.direction).toBe('sendrecv');
  });

  it('applies a session-level direction to the audio stream', () => {
    const sdp = parseSdp('v=0\r\nc=IN IP4 1.2.3.4\r\na=inactive\r\nm=audio 4000 RTP/AVP 0\r\n');
    expect(sdp.audio.direction).toBe('inactive');
  });

  it('tolerates a missing origin line', () => {
    const sdp = parseSdp('v=0\r\nc=IN IP4 1.2.3.4\r\nm=audio 4000 RTP/AVP 0\r\n');
    expect(sdp.origin).toEqual({ username: '-', sessionId: '0', version: '0', address: '1.2.3.4' });
  });

  it('raises MalformedSdpError without an m=audio line', () => {
    expect(() => parseSdp('v=0\r\nc=IN IP4 1.2.3.4\r\nm=video 5000 RTP/AVP 96\r\n')).toThrow(MalformedSdpError);
    expect(() => parseSdp('')).toThrow(MalformedSdpError);
  });

  it('raises MalformedSdpError without any connection address', () => {
    expect(() => parseSdp('v=0\r\nm=audio 4000 RTP/AVP 0\r\n')).toThrow(MalformedSdpError);
  });

  it('raises MalformedSdpError for a bad port', () => {
    expect(() => parseSdp('v=0\r\nc=IN IP4 1.2.3.4\r\nm=audio abc RTP/AVP 0\r\n')).toThrow(MalformedSdpError);
    expect(() => parseSdp('v=0\r\nc=IN IP4 1.2.3.4\r\nm=audio 70000 RTP/AVP 0\r\n')).toThrow(MalformedSdpError);
  });

  it('carries a short technical identifier', () => {
    try {
      parseSdp('');
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ name: 'MalformedSdpError', message: 'malformed-sdp' });
    }
  });
});

const description = (payloadTypes: number[], direction: SdpMedia['direction'] = 'sendrecv'): SessionDescription => ({
  origin: { username: '-', sessionId: '1', version: '1', address: '1.2.3.4' },
  connectionAddress: '1.2.3.4',
  audio: { port: 4000, payloadTypes, direction, rtpmap: {} }
});

describe('negotiate', () => {
  it('prefers PCMU over PCMA when both are offered, whatever the offer order', () => {
    expect(negotiate(description([8, 0, 101]), [0, 8]).payloadType).toBe(0);
    expect(negotiate(description([0, 8]), [8, 0]).payloadType).toBe(0);
  });

  it('falls back to PCMA when PCMU is not offered', () => {
    expect(negotiate(description([8, 101]), [0, 8]).payloadType).toBe(8);
  });

  it('follows local preference order, not the offer order', () => {
    expect(negotiate(description([0, 8]), [8]).payloadType).toBe(8);
  });

  it('never selects telephone-event as the voice codec', () => {
    expect(() => negotiate(description([101]), [101, 0])).toThrow(NoCommonCodecError);
  });

  it('throws when nothing is common', () => {
    expect(() => negotiate(description([18, 9]), [0, 8])).toThrow(NoCommonCodecError);
    expect(() => negotiate(description([]), [0, 8])).toThrow(NoCommonCodecError);
    expect(() => negotiate(description([0]), [])).toThrow(NoCommonCodecError);
  });

  it('names the error with a short identifier', () => {
    try {
      negotiate(description([18]), [0]);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ name: 'NoCommonCodecError', message: 'no-common-codec' });
    }
  });

  it.each([
    ['sendrecv', 'sendrecv'],
    ['sendonly', 'recvonly'],
    ['recvonly', 'sendonly'],
    ['inactive', 'inactive']
  ] as const)('answers a %s offer with %s', (offered, answered) => {
    expect(negotiate(description([0], offered), [0]).direction).toBe(answered);
  });
});

describe('hold and resume directions', () => {
  it.each([
    ['sendrecv', 'sendonly'],
    ['recvonly', 'inactive'],
    ['sendonly', 'sendonly'],
    ['inactive', 'inactive']
  ] as const)('hold %s -> %s', (from, to) => {
    expect(holdDirection(from)).toBe(to);
  });

  it.each([
    ['sendonly', 'sendrecv'],
    ['inactive', 'recvonly'],
    ['sendrecv', 'sendrecv'],
    ['recvonly', 'recvonly']
  ] as const)('resume %s -> %s', (from, to) => {
    expect(resumeDirection(from)).toBe(to);
  });
});

describe('parseSdp mutation-hardening cases', () => {
  it('does not take a direction from a video section that precedes the audio section', () => {
    const sdp = parseSdp(
      'v=0\r\nc=IN IP4 1.2.3.4\r\nm=video 5000 RTP/AVP 96\r\na=inactive\r\nm=audio 4000 RTP/AVP 0\r\n'
    );
    expect(sdp.audio.port).toBe(4000);
    expect(sdp.audio.payloadTypes).toEqual([0]);
    expect(sdp.audio.direction).toBe('sendrecv');
  });

  it('accepts an m=audio line on the very first line when it carries its own c= line', () => {
    const sdp = parseSdp('m=audio 4000 RTP/AVP 0\r\nc=IN IP4 1.2.3.4\r\n');
    expect(sdp.connectionAddress).toBe('1.2.3.4');
    expect(sdp.audio.port).toBe(4000);
    expect(sdp.origin).toEqual({ username: '-', sessionId: '0', version: '0', address: '1.2.3.4' });
  });

  it('lets an explicit audio sendrecv override a session-level direction', () => {
    const sdp = parseSdp('v=0\r\nc=IN IP4 1.2.3.4\r\na=sendonly\r\nm=audio 4000 RTP/AVP 0\r\na=sendrecv\r\n');
    expect(sdp.audio.direction).toBe('sendrecv');
  });

  it('lets an audio direction override a session-level direction', () => {
    const sdp = parseSdp('v=0\r\nc=IN IP4 1.2.3.4\r\na=sendrecv\r\nm=audio 4000 RTP/AVP 0\r\na=recvonly\r\n');
    expect(sdp.audio.direction).toBe('recvonly');
  });

  it('ignores non-attribute lines whose text looks like a direction', () => {
    const sdp = parseSdp('v=0\r\nc=IN IP4 1.2.3.4\r\nm=audio 4000 RTP/AVP 0\r\nx=recvonly\r\nb=inactive\r\n');
    expect(sdp.audio.direction).toBe('sendrecv');
  });

  it('ignores an a= attribute that is not a direction', () => {
    const sdp = parseSdp('v=0\r\nc=IN IP4 1.2.3.4\r\nm=audio 4000 RTP/AVP 0\r\na=ptime:20\r\n');
    expect(sdp.audio.direction).toBe('sendrecv');
  });

  it('rejects ports that are not purely digits', () => {
    for (const port of ['12ab', 'ab12', '-1', '1.5', '+80']) {
      expect(() => parseSdp(`v=0\r\nc=IN IP4 1.2.3.4\r\nm=audio ${port} RTP/AVP 0\r\n`)).toThrow(MalformedSdpError);
    }
  });

  it('accepts port 65535 and rejects 65536', () => {
    expect(parseSdp('v=0\r\nc=IN IP4 1.2.3.4\r\nm=audio 65535 RTP/AVP 0\r\n').audio.port).toBe(65535);
    expect(() => parseSdp('v=0\r\nc=IN IP4 1.2.3.4\r\nm=audio 65536 RTP/AVP 0\r\n')).toThrow(MalformedSdpError);
  });

  it('records an rtpmap line without a codec as an empty name', () => {
    const sdp = parseSdp('v=0\r\nc=IN IP4 1.2.3.4\r\nm=audio 4000 RTP/AVP 96\r\na=rtpmap:96\r\n');
    expect(sdp.audio.rtpmap).toEqual({ 96: '' });
  });
});

describe('buildOffer rejects codecs it cannot name', () => {
  const offer = (payloadTypes: readonly number[]): string =>
    buildOffer({ address: '10.0.0.1', port: 40000, sessionId: '1', payloadTypes });

  it('throws UnknownPayloadTypeError rather than emitting an empty rtpmap', () => {
    expect(() => offer([3])).toThrow(UnknownPayloadTypeError);
  });

  it('names the offending payload type on the error', () => {
    try {
      offer([99]);
      expect.unreachable('buildOffer should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownPayloadTypeError);
      expect((error as UnknownPayloadTypeError).payloadType).toBe(99);
      expect((error as UnknownPayloadTypeError).name).toBe('UnknownPayloadTypeError');
      expect((error as UnknownPayloadTypeError).message).toBe('unknown-payload-type');
    }
  });

  it('rejects the whole offer when only one of several types is unknown', () => {
    expect(() => offer([0, 8, 42])).toThrow(UnknownPayloadTypeError);
  });

  it('still builds an offer for every type it does know', () => {
    expect(offer([0, 8])).toContain('a=rtpmap:0 PCMU/8000');
    expect(offer([0, 8])).toContain('a=rtpmap:8 PCMA/8000');
    expect(offer([8])).toContain('a=rtpmap:101 telephone-event/8000');
  });
})
