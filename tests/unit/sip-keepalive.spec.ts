import { describe, expect, it } from 'vitest';
import {
  DATAGRAM_KEEPALIVE,
  STREAM_KEEPALIVE,
  decideKeepalive,
  keepalivePolicy,
  noteInbound,
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
    expect(startKeepalive(500)).toEqual({ lastSentAt: 500, lastInboundAt: 500 });
  });

  it('noteSent moves only the send clock, noteInbound only the inbound clock', () => {
    const state = { lastSentAt: 1, lastInboundAt: 2 };
    expect(noteSent(state, 9)).toEqual({ lastSentAt: 9, lastInboundAt: 2 });
    expect(noteInbound(state, 9)).toEqual({ lastSentAt: 1, lastInboundAt: 9 });
  });
});

describe('decideKeepalive', () => {
  const at = (sentAgo: number, inboundAgo: number) => decideKeepalive({ lastSentAt: 1_000_000 - sentAgo, lastInboundAt: 1_000_000 - inboundAgo }, 1_000_000, POLICY);

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

describe('CRLF keepalive framing', () => {
  it('is skipped by the stream framer, leading or between messages', () => {
    const message = 'OPTIONS sip:a SIP/2.0\r\nCall-ID: 1\r\nContent-Length: 0\r\n\r\n';
    expect(extractMessages('\r\n\r\n')).toEqual({ messages: [], rest: '' });
    const framed = extractMessages(`\r\n\r\n${message}\r\n\r\n${message}\r\n`);
    expect(framed.messages).toHaveLength(2);
    expect(framed.rest).toBe('');
  });

  it('is not a message on its own over a datagram, so the connection drops it silently', () => {
    expect(() => parse('\r\n\r\n')).toThrow();
  });
});
