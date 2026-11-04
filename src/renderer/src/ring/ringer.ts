/** A repeating synthesised tone: these frequencies together for `onSeconds`, then silence up to `cycleMs`. No audio file is shipped. */
export interface TonePattern {
  readonly frequencies: readonly number[];
  readonly onSeconds: number;
  readonly cycleMs: number;
}

const PEAK = 0.12;
const RAMP = 0.05;
const RELEASE = 0.03;

interface Engine {
  readonly ctx: AudioContext;
  readonly master: GainNode;
}

let engine: Engine | null = null;
let timer: number | null = null;
const live = new Set<OscillatorNode>();

function getEngine(): Engine | null {
  if (engine !== null) return engine;
  if (typeof AudioContext === 'undefined') return null;
  try {
    const ctx = new AudioContext();
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    engine = { ctx, master };
  } catch {
    engine = null;
  }
  return engine;
}

function resume(ctx: AudioContext): void {
  if (ctx.state === 'suspended') ctx.resume().catch(() => undefined);
}

/** Call from a user gesture: browsers and Electron may start the context suspended. */
export function unlockAudio(): void {
  const current = getEngine();
  if (current !== null) resume(current.ctx);
}

function burst({ ctx, master }: Engine, pattern: TonePattern): void {
  const start = ctx.currentTime + 0.02;
  const end = start + pattern.onSeconds;
  master.gain.cancelScheduledValues(start);
  master.gain.setValueAtTime(0, start);
  master.gain.linearRampToValueAtTime(PEAK, start + RAMP);
  master.gain.setValueAtTime(PEAK, end - RAMP);
  master.gain.linearRampToValueAtTime(0, end);
  for (const hz of pattern.frequencies) {
    const osc = ctx.createOscillator();
    osc.frequency.value = hz;
    osc.connect(master);
    osc.start(start);
    osc.stop(end + RAMP);
    live.add(osc);
    osc.onended = (): void => void live.delete(osc);
  }
}

/** Only one tone sounds at a time: starting another replaces the one playing. */
export function startTone(pattern: TonePattern): void {
  stopTone();
  const current = getEngine();
  if (current === null) return;
  resume(current.ctx);
  burst(current, pattern);
  timer = window.setInterval(() => burst(current, pattern), pattern.cycleMs);
}

/** Silences at once with a short release, so there is no click. */
export function stopTone(): void {
  if (timer === null) return;
  window.clearInterval(timer);
  timer = null;
  if (engine === null) return;
  const { ctx, master } = engine;
  master.gain.cancelScheduledValues(ctx.currentTime);
  master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
  master.gain.linearRampToValueAtTime(0, ctx.currentTime + RELEASE);
  live.forEach((osc) => osc.stop(ctx.currentTime + RELEASE + 0.01));
}
