import { describe, expect, it } from 'vitest';
import {
  DATAGRAM_KEEPALIVE,
  STREAM_KEEPALIVE,
  decideKeepalive,
  keepaliveMethod,
  keepalivePolicy,
  noteInbound,
  noteMedia,
  noteSent,
  startKeepalive
} from '../../src/core/sip/keepalive';
import { extractMessages, parse } from '../../src/core/sip/message';

const POLICY = { pingIntervalMs: 20_000, deadAfterMs: 60_000 };

describe('policies', () => {
  it('pings a datagram flow every 20 s and gives up after 60 s', () => {
    expect(DATAGRAM_KEEPALIVE).toEqual({ pingIntervalMs: 20_000, deadAfterMs: 60_000 });
  });

  it('pings a connection-oriented flow every 60 s and gives up after 180 s', () => {
    expect(STREAM_KEEPALIVE).toEqual({ pingIntervalMs: 60_000, deadAfterMs: 180_000 });
  });

  it('picks the datagram policy for UDP only', () => {
    expect(keepalivePolicy('udp')).toBe(DATAGRAM_KEEPALIVE);
    for (const transport of ['tcp', 'tls', 'ws', 'wss'] as const) expect(keepalivePolicy(transport)).toBe(STREAM_KEEPALIVE);
  });
});

describe('state', () => {
  it('starts with both clocks at now', () => {
    expect(startKeepalive(500)).toEqual({ lastSentAt: 500, lastInboundAt: 500, mediaPackets: 0 });
    expect(startKeepalive(500, 42).mediaPackets).toBe(42);
  });

  it('noteSent moves only the send clock, noteInbound only the inbound clock', () => {
    const state = { lastSentAt: 1, lastInboundAt: 2, mediaPackets: 7 };
    expect(noteSent(state, 9)).toEqual({ lastSentAt: 9, lastInboundAt: 2, mediaPackets: 7 });
    expect(noteInbound(state, 9)).toEqual({ lastSentAt: 1, lastInboundAt: 9, mediaPackets: 7 });
  });
});

describe('decideKeepalive', () => {
  const at = (sentAgo: number, inboundAgo: number) => decideKeepalive({ lastSentAt: 1_000_000 - sentAgo, lastInboundAt: 1_000_000 - inboundAgo, mediaPackets: 0 }, 1_000_000, POLICY);

  it('does nothing while both clocks are fresh', () => {
    expect(at(0, 0)).toBe('none');
    expect(at(19_999, 0)).toBe('none');
  });

  it('pings at exactly the interval, not one millisecond before', () => {
    expect(at(19_999, 5_000)).toBe('none');
    expect(at(20_000, 5_000)).toBe('ping');
    expect(at(45_000, 5_000)).toBe('ping');
  });

  it('declares the flow dead at exactly the dead-after period, not one millisecond before', () => {
    expect(at(0, 59_999)).toBe('none');
    expect(at(0, 60_000)).toBe('dead');
    expect(at(0, 3_600_000)).toBe('dead');
  });

  it('prefers dead over ping', () => {
    expect(at(25_000, 60_000)).toBe('dead');
    expect(at(25_000, 59_999)).toBe('ping');
  });

  it('is driven by inbound traffic that arrives, as the PBX CRLF pings would', () => {
    let state = startKeepalive(0);
    state = noteInbound(state, 50_000);
    expect(decideKeepalive(state, 100_000, POLICY)).toBe('ping');
    expect(decideKeepalive(state, 110_000, POLICY)).toBe('dead');
  });
});

describe('keepaliveMethod', () => {
  it('uses the RFC 5626 CRLF ping on UDP, TCP and TLS', () => {
    for (const transport of ['udp', 'tcp', 'tls'] as const) expect(keepaliveMethod(transport)).toBe('crlf');
  });

  it('keeps an OPTIONS request over WebSocket, where RFC 7118 uses protocol-level ping frames, not CRLF', () => {
    for (const transport of ['ws', 'wss'] as const) expect(keepaliveMethod(transport)).toBe('options');
  });
});

describe('noteMedia: RTP packets that keep arriving are proof the network is up', () => {
  const state = { lastSentAt: 0, lastInboundAt: 100, mediaPackets: 50 };

  it('treats a growing packet count as inbound traffic now', () => {
    expect(noteMedia(state, 51, 900)).toEqual({ lastSentAt: 0, lastInboundAt: 900, mediaPackets: 51 });
  });

  it('does not refresh liveness when the count is unchanged (a stalled call is no evidence)', () => {
    expect(noteMedia(state, 50, 900)).toEqual(state);
  });

  it('records a smaller count without refreshing, so a call that ended and a new one counting from zero still works', () => {
    const lower = noteMedia(state, 3, 900);
    expect(lower).toEqual({ lastSentAt: 0, lastInboundAt: 100, mediaPackets: 3 });
    expect(noteMedia(lower, 4, 950).lastInboundAt).toBe(950);
  });

  it('keeps a call with flowing media from ever being declared dead', () => {
    let current = startKeepalive(0);
    for (let at = 5_000, packets = 250; at <= 600_000; at += 5_000, packets += 250) {
      current = noteMedia(current, packets, at);
      expect(decideKeepalive(current, at, POLICY)).not.toBe('dead');
    }
  });

  it('declares death 60 s after the media stopped, not before', () => {
    const last = noteMedia(startKeepalive(0), 100, 10_000);
    expect(decideKeepalive(noteMedia(last, 100, 69_999), 69_999, POLICY)).not.toBe('dead');
    expect(decideKeepalive(noteMedia(last, 100, 70_000), 70_000, POLICY)).toBe('dead');
  });
});

describe('CRLF keepalive framing', () => {
  it('is skipped by the stream framer, leading or between messages', () => {
    const message = 'OPTIONS sip:a SIP/2.0\r\nCall-ID: 1\r\nContent-Length: 0\r\n\r\n';
    expect(extractMessages('\r\n\r\n')).toEqual({ messages: [], rest: '' });
    const framed = extractMessages(`\r\n\r\n${message}\r\n\r\n${message}\r\n`);
    expect(framed.messages).toHaveLength(2);
    expect(framed.rest).toBe('');
  });

  it('is not a message on its own over a datagram, so the connection must recognise it before parsing', () => {
    expect(() => parse('\r\n\r\n')).toThrow();
  });
});
