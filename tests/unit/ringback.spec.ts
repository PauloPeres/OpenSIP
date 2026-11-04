import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRAZIL_RINGBACK, NORTH_AMERICA_TONE, chooseTone, needsLocalRingback, ringbackFor } from '../../src/renderer/src/ring/tones';
import type { TonePrefs } from '../../src/renderer/src/ring/tones';
import type * as RingerModule from '../../src/renderer/src/ring/ringer';
import type { Line } from '../../src/renderer/src/state/useLines';
import type { CallView } from '../../src/shared/api';

const ON: TonePrefs = { ringtone: true, ringback: true };
const media = { rxPackets: 0, txPackets: 0, lostPackets: 0, muted: false };

function line(id: string, view: Partial<CallView> & { direction: 'inbound' | 'outbound'; state: 'ringing' | 'connecting' | 'active' }): Line {
  const { direction, state, ...rest } = view;
  return { slot: 1, view: { call: { id, accountId: 'a', remoteIdentity: 'sip:1@x', direction, state }, ...rest } };
}
const outboundRinging = (id = 'o1', extra: Partial<CallView> = {}): Line =>
  line(id, { direction: 'outbound', state: 'connecting', progress: 'calls.progress.ringing', ...extra });
const incoming = (id = 'i1'): Line => line(id, { direction: 'inbound', state: 'ringing' });

describe('which tone the phone makes', () => {
  it('plays local ringback for an outbound call the far end reports as ringing with no audio', () => {
    expect(chooseTone([outboundRinging()], ON, 'en')).toBe(NORTH_AMERICA_TONE);
  });

  it('plays nothing when the far end sent audio of its own (early media wins)', () => {
    const early = outboundRinging('o1', { media });
    expect(needsLocalRingback(early)).toBe(false);
    expect(chooseTone([early], ON, 'en')).toBeNull();
  });

  it.each(['calls.progress.trying', 'calls.progress.waiting', 'calls.progress.connecting', 'calls.progress.active', 'calls.progress.ended'])(
    'plays nothing while the call is %s: ringback stops the instant the call is answered, fails, or is cancelled',
    (progress) => {
      expect(chooseTone([outboundRinging('o1', { progress })], ON, 'en')).toBeNull();
    }
  );

  it('plays nothing once the call is over for a reason the user is told', () => {
    expect(chooseTone([outboundRinging('o1', { endReasonKey: 'calls.endReason.busy' })], ON, 'en')).toBeNull();
  });

  it('plays nothing when there are no calls at all', () => {
    expect(chooseTone([], ON, 'en')).toBeNull();
  });

  it('never rings back for an inbound call', () => {
    const inboundRinging = line('i2', { direction: 'inbound', state: 'ringing', progress: 'calls.progress.ringing' });
    expect(chooseTone([inboundRinging], { ringtone: false, ringback: true }, 'en')).toBeNull();
  });

  it('is one tone however many calls are in setup', () => {
    const tone = chooseTone([outboundRinging('o1'), outboundRinging('o2'), outboundRinging('o3')], ON, 'pt-BR');
    expect(tone).toBe(BRAZIL_RINGBACK);
  });

  it('keeps ringing back for the call that has none while another already has early media', () => {
    expect(chooseTone([outboundRinging('o1', { media }), outboundRinging('o2')], ON, 'en')).toBe(NORTH_AMERICA_TONE);
  });

  it('lets an incoming ring outrank ringback, so the two never sound together', () => {
    expect(chooseTone([outboundRinging(), incoming()], ON, 'pt-BR')).toBe(NORTH_AMERICA_TONE);
  });

  it('falls back to ringback when the incoming ring is switched off', () => {
    expect(chooseTone([outboundRinging(), incoming()], { ringtone: false, ringback: true }, 'pt-BR')).toBe(BRAZIL_RINGBACK);
  });

  it('keeps the two settings independent', () => {
    expect(chooseTone([outboundRinging()], { ringtone: true, ringback: false }, 'en')).toBeNull();
    expect(chooseTone([incoming()], { ringtone: false, ringback: true }, 'en')).toBeNull();
    expect(chooseTone([incoming()], { ringtone: true, ringback: false }, 'en')).toBe(NORTH_AMERICA_TONE);
  });
});

describe('ringback cadence', () => {
  it('is Brazilian for the Portuguese interface: 425 Hz, 1 s on, 4 s off', () => {
    expect(ringbackFor('pt-BR')).toEqual({ frequencies: [425], onSeconds: 1, cycleMs: 5000 });
  });

  it('is North American otherwise: 440 + 480 Hz, 2 s on, 4 s off', () => {
    expect(ringbackFor('en')).toEqual({ frequencies: [440, 480], onSeconds: 2, cycleMs: 6000 });
  });
});

/* ----------------------------------------------------- oscillator lifecycle */

interface FakeOsc { frequency: { value: number }; connect: () => void; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; onended: (() => void) | null }
const oscillators: FakeOsc[] = [];
const resume = vi.fn(() => Promise.resolve());
let contextState: 'running' | 'suspended' = 'running';

class FakeContext {
  currentTime = 0;
  destination = {};
  get state(): string { return contextState; }
  resume = resume;
  createGain(): unknown {
    return { gain: { value: 0, cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() }, connect: vi.fn() };
  }
  createOscillator(): FakeOsc {
    const osc: FakeOsc = { frequency: { value: 0 }, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null };
    oscillators.push(osc);
    return osc;
  }
}

const sounding = (): FakeOsc[] => oscillators.filter((o) => o.start.mock.calls.length > 0);
const silenced = (o: FakeOsc): boolean => o.stop.mock.calls.length > 1;

describe('the tone engine, driven through its oscillators', () => {
  let ringer: typeof RingerModule;

  beforeEach(async () => {
    vi.useFakeTimers();
    oscillators.length = 0;
    resume.mockClear();
    contextState = 'running';
    vi.stubGlobal('AudioContext', FakeContext);
    vi.stubGlobal('window', { setInterval, clearInterval });
    vi.resetModules();
    ringer = await import('../../src/renderer/src/ring/ringer');
  });
  afterEach(() => { ringer.stopTone(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('starts one oscillator per frequency at the pattern pitch, then repeats on the cycle', () => {
    ringer.startTone(BRAZIL_RINGBACK);
    expect(sounding().map((o) => o.frequency.value)).toEqual([425]);
    vi.advanceTimersByTime(5000);
    expect(sounding()).toHaveLength(2);
    vi.advanceTimersByTime(5000);
    expect(sounding()).toHaveLength(3);
  });

  it('stops every live oscillator and the repeat the moment it is told to', () => {
    ringer.startTone(NORTH_AMERICA_TONE);
    const before = sounding();
    expect(before).toHaveLength(2);
    ringer.stopTone();
    before.forEach((o) => expect(silenced(o)).toBe(true));
    vi.advanceTimersByTime(60_000);
    expect(sounding()).toHaveLength(2);
  });

  it('stopping an idle engine does nothing', () => {
    expect(() => ringer.stopTone()).not.toThrow();
    expect(oscillators).toHaveLength(0);
  });

  it('plays one tone at a time: a second start silences the first', () => {
    ringer.startTone(BRAZIL_RINGBACK);
    const first = sounding();
    ringer.startTone(NORTH_AMERICA_TONE);
    first.forEach((o) => expect(silenced(o)).toBe(true));
    expect(sounding().slice(first.length).map((o) => o.frequency.value)).toEqual([440, 480]);
    vi.advanceTimersByTime(6000);
    expect(sounding()).toHaveLength(first.length + 4);
    expect(sounding().slice(first.length + 2).map((o) => o.frequency.value)).toEqual([440, 480]);
  });

  it('resumes a suspended context when a tone starts and on a gesture', () => {
    contextState = 'suspended';
    ringer.startTone(NORTH_AMERICA_TONE);
    expect(resume).toHaveBeenCalledTimes(1);
    ringer.unlockAudio();
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it('forgets an oscillator that has ended', () => {
    ringer.startTone(BRAZIL_RINGBACK);
    const [osc] = sounding();
    osc?.onended?.();
    ringer.stopTone();
    expect(osc !== undefined && silenced(osc)).toBe(false);
  });

  it('stays silent, without throwing, where there is no audio at all', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('window', { setInterval, clearInterval });
    vi.resetModules();
    const bare = await import('../../src/renderer/src/ring/ringer');
    expect(() => { bare.unlockAudio(); bare.startTone(NORTH_AMERICA_TONE); bare.stopTone(); }).not.toThrow();
  });

  it('stays silent when the context cannot be created', async () => {
    vi.stubGlobal('AudioContext', class { constructor() { throw new Error('denied'); } });
    vi.resetModules();
    const broken = await import('../../src/renderer/src/ring/ringer');
    expect(() => { broken.startTone(NORTH_AMERICA_TONE); broken.stopTone(); }).not.toThrow();
  });
});
