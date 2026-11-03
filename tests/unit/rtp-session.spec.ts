import { describe, expect, it, vi } from 'vitest';
import {
  decodeALaw,
  decodeMuLaw,
  decodeRtp,
  encodeALaw,
  encodeMuLaw,
  encodeRtp,
  SAMPLES_PER_FRAME
} from '../../src/core/rtp';
import type { Endpoint, RtpHeader } from '../../src/core/rtp';
import { allocateRtpPort, createRtpSession } from '../../src/main/media/rtp-session';
import type { RtpDeps, RtpSession, RtpSessionOptions } from '../../src/main/media/rtp-session';
import { DTMF_DIGITS, isDtmfDigit } from '../../src/shared/api';

const SSRC = 0xdeadbeef;
const REMOTE = { host: '203.0.113.9', port: 40_002 };

type Notice = readonly ['info' | 'warn', string];

interface Sent {
  readonly data: Uint8Array;
  readonly port: number;
  readonly host: string;
}

function fakeDeps(): { deps: RtpDeps; sent: Sent[]; notices: Notice[]; receive: (data: Uint8Array, from?: Endpoint) => void; tick: () => void; state: { closed: number; cancelled: number; every: number | undefined } } {
  const sent: Sent[] = [];
  const state = { closed: 0, cancelled: 0, every: undefined as number | undefined };
  const notices: Notice[] = [];
  const handlers: { message?: (data: Uint8Array, from: Endpoint) => void; tick?: () => void } = {};
  const deps: RtpDeps = {
    socket: {
      send: (data, port, host) => void sent.push({ data, port, host }),
      onMessage: (listener) => void (handlers.message = listener),
      close: () => void (state.closed += 1)
    },
    timer: {
      every: (ms, tick) => {
        state.every = ms;
        handlers.tick = tick;
        return () => void (state.cancelled += 1);
      }
    },
    random: () => 1000,
    onNotice: (level, message) => void notices.push([level, message])
  };
  return {
    deps,
    sent,
    notices,
    state,
    receive: (data, from = { host: REMOTE.host, port: REMOTE.port }) => handlers.message?.(data, from),
    tick: () => handlers.tick?.()
  };
}

const options = (extra: Partial<RtpSessionOptions> = {}): RtpSessionOptions => ({
  localPort: 16_384,
  remoteHost: REMOTE.host,
  remotePort: REMOTE.port,
  payloadType: 0,
  ssrc: SSRC,
  ...extra
});

const ramp = (seed = 1): Int16Array => Int16Array.from({ length: SAMPLES_PER_FRAME }, (_, i) => (i * 37 * seed) % 8000);
const header = (over: Partial<RtpHeader> = {}): RtpHeader => ({
  version: 2,
  padding: false,
  extension: false,
  csrcCount: 0,
  marker: false,
  payloadType: 0,
  sequenceNumber: 0,
  timestamp: 0,
  ssrc: 7,
  csrc: [],
  ...over
});
const wire = (seq: number, payload: Uint8Array, over: Partial<RtpHeader> = {}): Uint8Array =>
  encodeRtp({ header: header({ sequenceNumber: seq, timestamp: seq * 160, ...over }), payload });
const audioPacket = (seq: number, pcm: Int16Array = ramp(seq)): Uint8Array => wire(seq, encodeMuLaw(pcm));

function start(extra: Partial<RtpSessionOptions> = {}): ReturnType<typeof fakeDeps> & { session: RtpSession } {
  const fake = fakeDeps();
  return { ...fake, session: createRtpSession(options(extra), fake.deps) };
}

function playback(session: RtpSession): Int16Array[] {
  const frames: Int16Array[] = [];
  session.onPcm((frame) => void frames.push(frame));
  return frames;
}

describe('outbound audio', () => {
  it('turns one 20 ms frame into exactly one correctly formed RTP packet', () => {
    const { session, sent } = start();
    const pcm = ramp();
    session.sendPcm(pcm);
    expect(sent).toHaveLength(1);
    const { data, host, port } = sent[0] as Sent;
    expect([host, port]).toEqual([REMOTE.host, REMOTE.port]);
    const packet = decodeRtp(data);
    expect(packet.header).toMatchObject({ version: 2, payloadType: 0, ssrc: SSRC, padding: false, extension: false, csrcCount: 0 });
    expect(packet.payload).toEqual(encodeMuLaw(pcm));
    expect(packet.payload).toHaveLength(SAMPLES_PER_FRAME);
  });

  it('encodes with A-law when PCMA was negotiated', () => {
    const { session, sent } = start({ payloadType: 8 });
    const pcm = ramp();
    session.sendPcm(pcm);
    const packet = decodeRtp((sent[0] as Sent).data);
    expect(packet.header.payloadType).toBe(8);
    expect(packet.payload).toEqual(encodeALaw(pcm));
  });

  it('increments the sequence number and advances the timestamp by 160 per frame', () => {
    const { session, sent } = start();
    for (let i = 0; i < 4; i += 1) session.sendPcm(ramp(i + 1));
    const headers = sent.map((s) => decodeRtp(s.data).header);
    expect(headers.map((h) => h.sequenceNumber)).toEqual([1000, 1001, 1002, 1003]);
    expect(headers.map((h) => h.timestamp)).toEqual([1000, 1160, 1320, 1480]);
  });

  it('wraps the sequence number at 16 bits', () => {
    const fake = fakeDeps();
    const session = createRtpSession(options(), { ...fake.deps, random: () => 0xffff });
    session.sendPcm(ramp());
    session.sendPcm(ramp());
    const seqs = fake.sent.map((s) => decodeRtp(s.data).header.sequenceNumber);
    expect(seqs).toEqual([0xffff, 0]);
  });

  it('sets the marker bit on the first packet of the talkspurt only', () => {
    const { session, sent } = start();
    for (let i = 0; i < 3; i += 1) session.sendPcm(ramp());
    expect(sent.map((s) => decodeRtp(s.data).header.marker)).toEqual([true, false, false]);
  });

  it('draws a random SSRC from the injected source when none is given', () => {
    const fake = fakeDeps();
    const rest: RtpSessionOptions = { localPort: 16_384, remoteHost: REMOTE.host, remotePort: REMOTE.port, payloadType: 0 };
    const session = createRtpSession(rest, { ...fake.deps, random: () => 0x01020304 });
    session.sendPcm(ramp());
    expect(decodeRtp((fake.sent[0] as Sent).data).header.ssrc).toBe(0x01020304);
  });

  it('drops frames that are not exactly one 20 ms frame', () => {
    const { session, sent } = start();
    session.sendPcm(new Int16Array(80));
    session.sendPcm(new Int16Array(320));
    expect(sent).toHaveLength(0);
    expect(session.stats.txPackets).toBe(0);
  });

  it('counts transmitted packets', () => {
    const { session } = start();
    session.sendPcm(ramp());
    session.sendPcm(ramp());
    expect(session.stats.txPackets).toBe(2);
  });
});

describe('muting', () => {
  it('keeps sending while muted, but as silence', () => {
    const { session, sent } = start();
    session.setMuted(true);
    session.sendPcm(ramp());
    expect(sent).toHaveLength(1);
    const payload = decodeRtp((sent[0] as Sent).data).payload;
    expect(payload).toEqual(encodeMuLaw(new Int16Array(SAMPLES_PER_FRAME)));
    expect(session.stats.muted).toBe(true);
  });

  it('keeps the sequence and timestamp running while muted, then resumes real audio', () => {
    const { session, sent } = start();
    session.sendPcm(ramp());
    session.setMuted(true);
    session.sendPcm(ramp());
    session.setMuted(false);
    const pcm = ramp(3);
    session.sendPcm(pcm);
    const packets = sent.map((s) => decodeRtp(s.data));
    expect(packets.map((p) => p.header.sequenceNumber)).toEqual([1000, 1001, 1002]);
    expect(packets.map((p) => p.header.timestamp)).toEqual([1000, 1160, 1320]);
    expect(packets[2]?.payload).toEqual(encodeMuLaw(pcm));
    expect(session.stats.muted).toBe(false);
  });

  it('sends PCMA silence when muted on an A-law call', () => {
    const { session, sent } = start({ payloadType: 8 });
    session.setMuted(true);
    session.sendPcm(ramp());
    expect(decodeRtp((sent[0] as Sent).data).payload).toEqual(encodeALaw(new Int16Array(SAMPLES_PER_FRAME)));
  });
});

describe('inbound audio', () => {
  it('ticks every 20 ms', () => {
    const { state } = start();
    expect(state.every).toBe(20);
  });

  it('emits comfort silence on every tick when nothing has arrived, so the audio clock never stalls', () => {
    const { session, tick } = start();
    const frames = playback(session);
    tick();
    tick();
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual(new Int16Array(SAMPLES_PER_FRAME));
    expect(frames[0]).toHaveLength(SAMPLES_PER_FRAME);
  });

  it('decodes PCMU packets after the jitter buffer has prebuffered', () => {
    const { session, receive, tick } = start();
    const frames = playback(session);
    const sources = [ramp(1), ramp(2), ramp(3)];
    sources.forEach((pcm, i) => receive(audioPacket(10 + i, pcm)));
    tick();
    tick();
    tick();
    expect(frames).toHaveLength(3);
    sources.forEach((pcm, i) => expect(frames[i]).toEqual(decodeMuLaw(encodeMuLaw(pcm))));
  });

  it('decodes PCMA when negotiated', () => {
    const { session, receive, tick } = start({ payloadType: 8 });
    const frames = playback(session);
    for (let i = 0; i < 3; i += 1) receive(wire(i, encodeALaw(ramp(i + 1)), { payloadType: 8 }));
    tick();
    expect(frames[0]).toEqual(decodeALaw(encodeALaw(ramp(1))));
  });

  it('ignores a packet whose payload type is neither the negotiated one nor the DTMF one', () => {
    const { session, receive, tick } = start();
    const frames = playback(session);
    for (let i = 0; i < 3; i += 1) receive(wire(i, encodeMuLaw(ramp(i + 1)), { payloadType: 18 }));
    tick();
    expect(session.stats.rxPackets).toBe(0);
    expect(frames[0]).toEqual(new Int16Array(SAMPLES_PER_FRAME));
  });

  it('never plays inbound telephone-event packets as audio, nor counts them as lost audio', () => {
    const { session, receive, tick } = start({ dtmfPayloadType: 101 });
    const frames = playback(session);
    const pcm = ramp(2);
    [0, 1, 2].forEach((seq) => receive(audioPacket(seq, pcm)));
    [3, 4, 5].forEach((seq) => receive(wire(seq, Uint8Array.of(5, 10, 0, 160), { payloadType: 101 })));
    [6, 7, 8].forEach((seq) => receive(audioPacket(seq, pcm)));
    for (let i = 0; i < 9; i += 1) tick();
    expect(session.stats.lostPackets).toBe(0);
    const silent = new Int16Array(SAMPLES_PER_FRAME);
    expect(frames.map((f) => f.some((v) => v !== 0))).toEqual([true, true, true, false, false, false, true, true, true]);
    expect(frames[3]).toEqual(silent);
  });

  it('ignores telephone-event packets when none was negotiated', () => {
    const { session, receive } = start();
    receive(wire(1, Uint8Array.of(5, 10, 0, 160), { payloadType: 101 }));
    expect(session.stats.rxPackets).toBe(0);
  });

  it('ignores datagrams that are not RTP and payloads that are not whole 10 ms slices', () => {
    const { session, receive } = start();
    receive(Uint8Array.of(1, 2, 3));
    receive(wire(1, new Uint8Array(0)));
    receive(wire(2, new Uint8Array(100)));
    expect(session.stats.rxPackets).toBe(0);
  });

  it('strips RTP padding before decoding', () => {
    const { session, receive, tick } = start();
    const frames = playback(session);
    const pcm = ramp(2);
    for (let i = 0; i < 3; i += 1) {
      const padded = Uint8Array.of(...encodeMuLaw(pcm), 0, 0, 0, 4);
      receive(wire(i, padded, { padding: true }));
    }
    tick();
    expect(session.stats.rxPackets).toBe(3);
    expect(frames[0]).toEqual(decodeMuLaw(encodeMuLaw(pcm)));
  });

  it('strips an RTP extension header before decoding', () => {
    const { session, receive, tick } = start();
    const frames = playback(session);
    const extension = Uint8Array.of(0xbe, 0xde, 0, 2, 1, 2, 3, 4, 5, 6, 7, 8);
    for (let i = 0; i < 3; i += 1) {
      receive(wire(i, Uint8Array.of(...extension, ...encodeMuLaw(ramp(2))), { extension: true }));
    }
    tick();
    expect(session.stats.rxPackets).toBe(3);
    expect(frames[0]).toEqual(decodeMuLaw(encodeMuLaw(ramp(2))));
  });

  it('decodes identically with or without the padding and extension wrapper', () => {
    const plain = start();
    const wrapped = start();
    const a = playback(plain.session);
    const b = playback(wrapped.session);
    const pcm = ramp(5);
    const extension = Uint8Array.of(0xbe, 0xde, 0, 1, 9, 9, 9, 9);
    for (let i = 0; i < 3; i += 1) {
      plain.receive(wire(i, encodeMuLaw(pcm)));
      const body = Uint8Array.of(...extension, ...encodeMuLaw(pcm), 0, 2);
      wrapped.receive(wire(i, body, { extension: true, padding: true }));
    }
    plain.tick();
    wrapped.tick();
    expect(b[0]).toEqual(a[0]);
  });

  it('drops packets whose padding or extension length overruns the payload', () => {
    const { session, receive } = start();
    receive(wire(1, Uint8Array.of(...encodeMuLaw(ramp()), 255), { padding: true }));
    receive(wire(2, Uint8Array.of(0xbe, 0xde, 0xff, 0xff, 1, 2), { extension: true }));
    receive(wire(3, Uint8Array.of(1, 2), { extension: true }));
    receive(wire(4, new Uint8Array(0), { padding: true }));
    expect(session.stats.rxPackets).toBe(0);
  });

  it('feeds the jitter buffer counters into stats', () => {
    const { session, receive, tick } = start();
    playback(session);
    [1, 2, 3, 5, 6].forEach((seq) => receive(audioPacket(seq)));
    for (let i = 0; i < 6; i += 1) tick();
    expect(session.stats.rxPackets).toBe(5);
    expect(session.stats.lostPackets).toBe(1);
  });

  it('stops notifying a listener once it has unsubscribed', () => {
    const { session, tick } = start();
    const listener = vi.fn();
    const off = session.onPcm(listener);
    tick();
    off();
    tick();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('DTMF (RFC 4733)', () => {
  const events = (sent: Sent[]): { header: RtpHeader; event: number; end: boolean; volume: number; duration: number }[] =>
    sent.map((s) => {
      const packet = decodeRtp(s.data);
      const [event = 0, flags = 0, high = 0, low = 0] = packet.payload;
      return { header: packet.header, event, end: (flags & 0x80) !== 0, volume: flags & 0x3f, duration: (high << 8) | low };
    });

  const play = (digit: string): ReturnType<typeof start> => {
    const run = start({ dtmfPayloadType: 101 });
    run.session.sendDtmf(digit);
    for (let i = 0; i < 12; i += 1) run.tick();
    return run;
  };

  it('sends a start packet immediately, repeats on the 20 ms tick, then three end packets with the E bit', () => {
    const { sent } = play('5');
    const parsed = events(sent);
    expect(parsed.map((p) => p.end)).toEqual([false, false, false, false, true, true, true]);
    expect(parsed.map((p) => p.duration)).toEqual([160, 320, 480, 640, 800, 800, 800]);
    expect(parsed.every((p) => p.event === 5 && p.header.payloadType === 101 && p.volume === 10)).toBe(true);
  });

  it('marks only the start packet, keeps one RTP timestamp for the whole event, and sequences contiguously', () => {
    const { sent } = play('9');
    const parsed = events(sent);
    expect(parsed.map((p) => p.header.marker)).toEqual([true, false, false, false, false, false, false]);
    expect(new Set(parsed.map((p) => p.header.timestamp)).size).toBe(1);
    const seqs = parsed.map((p) => p.header.sequenceNumber);
    expect(seqs).toEqual(seqs.map((_, i) => (seqs[0] as number) + i));
  });

  it('sends the first packet synchronously, before any tick', () => {
    const { session, sent } = start({ dtmfPayloadType: 101 });
    session.sendDtmf('1');
    expect(sent).toHaveLength(1);
  });

  it('maps every digit to its RFC 4733 event code', () => {
    const codes = DTMF_DIGITS.map((digit) => {
      const run = start({ dtmfPayloadType: 101 });
      run.session.sendDtmf(digit);
      return events(run.sent)[0]?.event;
    });
    expect(codes).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it('resumes audio after the event with a timestamp that accounts for its duration', () => {
    const { session, sent, tick } = start({ dtmfPayloadType: 101 });
    session.sendPcm(ramp());
    session.sendDtmf('1');
    for (let i = 0; i < 8; i += 1) tick();
    session.sendPcm(ramp());
    const packets = sent.map((s) => decodeRtp(s.data));
    const first = packets[0] as ReturnType<typeof decodeRtp>;
    const last = packets[packets.length - 1] as ReturnType<typeof decodeRtp>;
    expect(last.header.payloadType).toBe(0);
    expect(last.header.marker).toBe(false);
    expect(last.header.sequenceNumber).toBe(first.header.sequenceNumber + packets.length - 1);
    expect(last.header.timestamp).toBe(first.header.timestamp + 160 + 800);
  });

  it('does not send microphone audio while a digit is being signalled', () => {
    const { session, sent } = start({ dtmfPayloadType: 101 });
    session.sendDtmf('1');
    session.sendPcm(ramp());
    expect(sent).toHaveLength(1);
  });

  it('plays queued digits one after another', () => {
    const { session, sent, tick } = start({ dtmfPayloadType: 101 });
    session.sendDtmf('1');
    session.sendDtmf('2');
    for (let i = 0; i < 20; i += 1) tick();
    const parsed = events(sent);
    expect(parsed.filter((p) => p.header.marker).map((p) => p.event)).toEqual([1, 2]);
    expect(parsed).toHaveLength(14);
  });

  it('sends nothing when the peer did not offer telephone-event', () => {
    const { session, sent, tick } = start();
    session.sendDtmf('5');
    tick();
    expect(sent).toHaveLength(0);
  });

  it('ignores a digit that is not a DTMF digit', () => {
    const { session, sent } = start({ dtmfPayloadType: 101 });
    session.sendDtmf('x');
    session.sendDtmf('55');
    session.sendDtmf('');
    expect(sent).toHaveLength(0);
  });

  it('validates digits at the boundary', () => {
    expect(DTMF_DIGITS.every(isDtmfDigit)).toBe(true);
    for (const bad of ['', 'a', 'E', '55', '\u0000', 5, null, undefined, {}, ['1']]) {
      expect(isDtmfDigit(bad)).toBe(false);
    }
  });
});

describe('close()', () => {
  it('releases the socket and the timer', () => {
    const { session, state } = start();
    session.close();
    expect(state.closed).toBe(1);
    expect(state.cancelled).toBe(1);
  });

  it('is idempotent', () => {
    const { session, state } = start();
    session.close();
    session.close();
    expect(state.closed).toBe(1);
    expect(state.cancelled).toBe(1);
  });

  it('stops sending, receiving, signalling and notifying', () => {
    const { session, sent, receive, tick } = start({ dtmfPayloadType: 101 });
    const frames = playback(session);
    session.close();
    session.sendPcm(ramp());
    session.sendDtmf('1');
    for (let i = 0; i < 3; i += 1) receive(audioPacket(i));
    tick();
    expect(sent).toHaveLength(0);
    expect(frames).toHaveLength(0);
    expect(session.stats.rxPackets).toBe(0);
  });

  it('reports the port it was asked to use', () => {
    expect(start({ localPort: 20_000 }).session.localPort).toBe(20_000);
  });
});

describe('allocateRtpPort', () => {
  it('returns an even port in 16384..32767', async () => {
    const ports = await Promise.all(Array.from({ length: 10 }, () => allocateRtpPort()));
    for (const port of ports) {
      expect(port % 2).toBe(0);
      expect(port).toBeGreaterThanOrEqual(16_384);
      expect(port).toBeLessThanOrEqual(32_766);
    }
  });

  it('skips ports that are busy', async () => {
    const asked: number[] = [];
    const free = async (port: number): Promise<boolean> => {
      asked.push(port);
      return asked.length > 2;
    };
    const port = await allocateRtpPort({ isFree: free, random: () => 0.5 });
    expect(asked.length).toBe(3);
    expect(port % 2).toBe(0);
  });

  it('gives up after a bounded number of attempts', async () => {
    await expect(allocateRtpPort({ isFree: async () => false, random: () => 0.1 })).rejects.toThrow();
  });
});

/* ---------------------------------------------------- defect 2: packetisation */

describe('inbound packetisation (10, 20, 30, 40 ms)', () => {
  /** Streams `seconds` of a ramp in packets of `bytes`, ticking every 20 ms, returns the played frames. */
  function playStream(bytes: number, packets: number): { frames: Int16Array[]; source: Int16Array; session: RtpSession } {
    const { session, receive, tick } = start();
    const frames = playback(session);
    const source = Int16Array.from({ length: bytes * packets }, (_, i) => ((i * 53) % 7000) - 3500);
    const encoded = encodeMuLaw(source);
    for (let p = 0; p < packets; p += 1) receive(wire(p, encoded.slice(p * bytes, (p + 1) * bytes)));
    const ticks = (bytes * packets) / SAMPLES_PER_FRAME;
    for (let i = 0; i < ticks + 3; i += 1) tick();
    return { frames, source: decodeMuLaw(encoded), session };
  }

  const flatten = (frames: Int16Array[]): number[] => frames.flatMap((f) => [...f]);

  it.each([80, 160, 240, 320])('plays a %i-byte payload as the same audio, in whole 20 ms frames', (bytes) => {
    const packets = 8;
    const { frames, source, session } = playStream(bytes, packets);
    expect(frames.every((f) => f.length === SAMPLES_PER_FRAME)).toBe(true);
    const played = flatten(frames);
    const first = played.findIndex((v) => v !== 0);
    expect(played.slice(first, first + source.length - 1)).toEqual([...source].slice(first, first + source.length - 1));
    expect(session.stats.rxPackets).toBe(packets);
    expect(session.stats.lostPackets).toBe(0);
  });

  it.each([0, 40, 79, 100, 161, 410, 960 + 80])('drops a %i-byte payload, which is not whole 10 ms slices', (bytes) => {
    const { session, receive } = start();
    receive(wire(1, new Uint8Array(bytes)));
    expect(session.stats.rxPackets).toBe(0);
  });

  it('accepts the longest supported payload (120 ms)', () => {
    const { session, receive } = start();
    receive(wire(1, new Uint8Array(960)));
    expect(session.stats.rxPackets).toBe(1);
  });

  it('pulls from the jitter buffer only as fast as the samples are consumed (40 ms packets)', () => {
    const { session, receive, tick } = start();
    playback(session);
    for (let p = 0; p < 6; p += 1) receive(wire(p, new Uint8Array(320).fill(0x10)));
    for (let i = 0; i < 8; i += 1) tick();
    expect(session.stats.lostPackets).toBe(0);
  });

  it('logs an unusable length once, not once per packet', () => {
    const { receive, notices } = start();
    for (let seq = 0; seq < 50; seq += 1) receive(wire(seq, new Uint8Array(100)));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.[0]).toBe('warn');
    expect(notices[0]?.[1]).toContain('100-byte');
  });

  it('stays quiet while every payload is usable', () => {
    const { receive, notices } = start();
    [80, 160, 240, 320].forEach((bytes, seq) => receive(wire(seq, new Uint8Array(bytes))));
    expect(notices).toEqual([]);
  });

  it('keeps sending our own audio at 20 ms', () => {
    const { session, sent } = start();
    session.sendPcm(ramp());
    expect(decodeRtp(sent[0]?.data as Uint8Array).payload).toHaveLength(SAMPLES_PER_FRAME);
  });

  it('conceals a lost 40 ms packet with 40 ms of silence, keeping the timeline', () => {
    const { session, receive, tick } = start();
    const frames = playback(session);
    [0, 1, 2, 4, 5].forEach((seq) => receive(wire(seq, new Uint8Array(320).fill(0x10))));
    for (let i = 0; i < 12; i += 1) tick();
    expect(session.stats.lostPackets).toBe(1);
    const audible = frames.map((f) => f.some((v) => v !== 0));
    expect(audible).toEqual([true, true, true, true, true, true, false, false, true, true, true, true]);
  });
});

/* ----------------------------------------------------- defect 3: watchdog */

describe('inbound inactivity watchdog', () => {
  const TIMEOUT_MS = 200; // 10 ticks
  const idle = (extra: Partial<RtpSessionOptions> = {}): ReturnType<typeof start> =>
    start({ inboundTimeoutMs: TIMEOUT_MS, ...extra });
  const ticks = (tick: () => void, count: number): void => {
    for (let i = 0; i < count; i += 1) tick();
  };
  const stalled = (notices: Notice[]): Notice[] => notices.filter(([, text]) => text.includes('no inbound'));

  it('stays silent one tick before the timeout', () => {
    const { tick, notices } = idle();
    ticks(tick, 9);
    expect(stalled(notices)).toEqual([]);
  });

  it('warns on the tick that reaches the timeout', () => {
    const { tick, notices } = idle();
    ticks(tick, 10);
    expect(stalled(notices)).toHaveLength(1);
    expect(stalled(notices)[0]?.[0]).toBe('warn');
    expect(stalled(notices)[0]?.[1]).toContain('0.2s');
  });

  it('warns once per episode, not on every later tick', () => {
    const { tick, notices } = idle();
    ticks(tick, 100);
    expect(stalled(notices)).toHaveLength(1);
  });

  it('defaults to 30 s: silent at 1499 ticks, warns at 1500', () => {
    const { tick, notices } = start();
    ticks(tick, 1499);
    expect(stalled(notices)).toEqual([]);
    tick();
    expect(stalled(notices)).toHaveLength(1);
    expect(stalled(notices)[0]?.[1]).toContain('30s');
  });

  it('counts packets, not sound: a stream of silence keeps the call alive', () => {
    const { tick, receive, notices } = idle();
    for (let i = 0; i < 40; i += 1) {
      receive(audioPacket(i, new Int16Array(SAMPLES_PER_FRAME)));
      tick();
    }
    expect(notices).toEqual([]);
  });

  it('counts a packet with an unusable length as life', () => {
    const { tick, receive, notices } = idle();
    for (let i = 0; i < 40; i += 1) {
      receive(wire(i, new Uint8Array(100)));
      tick();
    }
    expect(stalled(notices)).toEqual([]);
  });

  it('counts a packet of any payload type as life', () => {
    const { tick, receive, notices } = idle();
    for (let i = 0; i < 40; i += 1) {
      receive(wire(i, new Uint8Array(20), { payloadType: 13 }));
      tick();
    }
    expect(stalled(notices)).toEqual([]);
  });

  it('is not fooled by garbage that is not RTP', () => {
    const { tick, receive, notices } = idle();
    for (let i = 0; i < 10; i += 1) {
      receive(Uint8Array.of(1, 2, 3));
      tick();
    }
    expect(stalled(notices)).toHaveLength(1);
  });

  it('restarts the count when a packet arrives one tick before the limit', () => {
    const { tick, receive, notices } = idle();
    ticks(tick, 9);
    receive(audioPacket(1));
    ticks(tick, 9);
    expect(stalled(notices)).toEqual([]);
    tick();
    expect(stalled(notices)).toHaveLength(1);
  });

  it('reports recovery once, and can stall again afterwards', () => {
    const { tick, receive, notices } = idle();
    ticks(tick, 10);
    receive(audioPacket(1));
    receive(audioPacket(2));
    expect(notices.filter(([, text]) => text.includes('resumed'))).toEqual([['info', 'rtp: inbound packets resumed']]);
    ticks(tick, 10);
    expect(stalled(notices)).toHaveLength(2);
  });

  it('does not say "resumed" when it never stalled', () => {
    const { receive, notices } = idle();
    receive(audioPacket(1));
    expect(notices).toEqual([]);
  });

  it('pauses while the call is on hold, and starts counting afresh on resume', () => {
    const { session, tick, notices } = idle();
    session.setHeld(true);
    ticks(tick, 100);
    expect(notices).toEqual([]);
    session.setHeld(false);
    ticks(tick, 9);
    expect(stalled(notices)).toEqual([]);
    tick();
    expect(stalled(notices)).toHaveLength(1);
  });

  it('clears a raised alarm when the call is put on hold', () => {
    const { session, tick, receive, notices } = idle();
    ticks(tick, 10);
    session.setHeld(true);
    receive(audioPacket(1));
    expect(notices.filter(([, text]) => text.includes('resumed'))).toEqual([]);
  });

  it('never fires after close()', () => {
    const { session, tick, notices } = idle();
    session.close();
    ticks(tick, 50);
    expect(notices).toEqual([]);
  });

  it('works without a notice sink', () => {
    const fake = fakeDeps();
    createRtpSession(options({ inboundTimeoutMs: TIMEOUT_MS }), { socket: fake.deps.socket, timer: fake.deps.timer, random: fake.deps.random });
    expect(() => ticks(fake.tick, 20)).not.toThrow();
  });
});

/* ------------------------------------------------------ defect 4: latching */

describe('symmetric RTP (latching)', () => {
  const NAT: Endpoint = { host: '198.51.100.7', port: 55_000 };
  const OTHER: Endpoint = { host: '192.0.2.99', port: 4000 };
  const latest = (sent: Sent[]): Sent => sent[sent.length - 1] as Sent;
  const frames = (env: ReturnType<typeof start>, source: Endpoint, count: number, from = 0, ssrc = 7): void => {
    for (let i = 0; i < count; i += 1) env.receive(audioPacket(from + i, ramp(), ssrc), source);
  };
  function audioPacket(seq: number, pcm: Int16Array = ramp(seq), ssrc = 7): Uint8Array {
    return wire(seq, encodeMuLaw(pcm), { ssrc });
  }

  it('sends to the SDP address until something proves otherwise', () => {
    const env = start();
    env.session.sendPcm(ramp());
    expect(latest(env.sent)).toMatchObject(REMOTE);
  });

  it('latches after 5 consecutive packets from one other source', () => {
    const env = start();
    frames(env, NAT, 5);
    env.session.sendPcm(ramp());
    expect(latest(env.sent)).toMatchObject({ host: NAT.host, port: NAT.port });
    expect(env.notices.some(([level, text]) => level === 'info' && text.includes('latched'))).toBe(true);
  });

  it('does not latch one packet short of the confirmation count', () => {
    const env = start();
    frames(env, NAT, 4);
    env.session.sendPcm(ramp());
    expect(latest(env.sent)).toMatchObject(REMOTE);
  });

  it('does not latch on a single stray packet', () => {
    const env = start();
    frames(env, NAT, 1);
    env.session.sendPcm(ramp());
    expect(latest(env.sent)).toMatchObject(REMOTE);
  });

  it('a stray in the middle restarts the count', () => {
    const env = start();
    frames(env, NAT, 3);
    frames(env, OTHER, 1, 3);
    frames(env, NAT, 2, 4);
    env.session.sendPcm(ramp());
    expect(latest(env.sent)).toMatchObject(REMOTE);
  });

  it('requires one SSRC across the confirmation run', () => {
    const env = start();
    frames(env, NAT, 4);
    frames(env, NAT, 1, 4, 99);
    env.session.sendPcm(ramp());
    expect(latest(env.sent)).toMatchObject(REMOTE);
  });

  it('requires consecutive sequence numbers across the run', () => {
    const env = start();
    [0, 1, 2, 3, 5].forEach((seq) => env.receive(audioPacket(seq), NAT));
    env.session.sendPcm(ramp());
    expect(latest(env.sent)).toMatchObject(REMOTE);
  });

  it('never latches away from an address that is already delivering audio', () => {
    const env = start();
    frames(env, { host: REMOTE.host, port: REMOTE.port }, 1);
    frames(env, NAT, 20, 1);
    env.session.sendPcm(ramp());
    expect(latest(env.sent)).toMatchObject(REMOTE);
  });

  it('never re-latches once latched', () => {
    const env = start();
    frames(env, NAT, 5);
    frames(env, OTHER, 20, 5);
    env.session.sendPcm(ramp());
    expect(latest(env.sent)).toMatchObject({ host: NAT.host, port: NAT.port });
  });

  it('stops latching once the call is more than 10 s old (500 ticks)', () => {
    const env = start();
    for (let i = 0; i < 500; i += 1) env.tick();
    frames(env, NAT, 20);
    env.session.sendPcm(ramp());
    expect(latest(env.sent)).toMatchObject(REMOTE);
  });

  it('still latches one tick before the window closes', () => {
    const env = start();
    for (let i = 0; i < 499; i += 1) env.tick();
    frames(env, NAT, 5);
    env.session.sendPcm(ramp());
    expect(latest(env.sent)).toMatchObject({ host: NAT.host, port: NAT.port });
  });

  it('ignores packets of an unnegotiated payload type when latching', () => {
    const env = start();
    for (let i = 0; i < 10; i += 1) env.receive(wire(i, new Uint8Array(20), { payloadType: 13 }), NAT);
    env.session.sendPcm(ramp());
    expect(latest(env.sent)).toMatchObject(REMOTE);
  });

  it('counts telephone-event packets toward a latch', () => {
    const env = start({ dtmfPayloadType: 101 });
    for (let i = 0; i < 5; i += 1) env.receive(wire(i, Uint8Array.of(5, 10, 0, 160), { payloadType: 101 }), NAT);
    env.session.sendDtmf('5');
    expect(latest(env.sent)).toMatchObject({ host: NAT.host, port: NAT.port });
  });

  it('sends DTMF and audio to the latched address alike', () => {
    const env = start({ dtmfPayloadType: 101 });
    frames(env, NAT, 5);
    env.session.sendPcm(ramp());
    env.session.sendDtmf('1');
    expect(env.sent.slice(-2).every((s) => s.host === NAT.host && s.port === NAT.port)).toBe(true);
  });
});
