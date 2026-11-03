/** A synthesised North American ring (440 + 480 Hz, two seconds on, four off). No audio file is shipped. */
const FREQUENCIES: readonly number[] = [440, 480];
const ON_SECONDS = 2;
const CYCLE_MS = 6000;
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

function burst({ ctx, master }: Engine): void {
  const start = ctx.currentTime + 0.02;
  const end = start + ON_SECONDS;
  master.gain.cancelScheduledValues(start);
  master.gain.setValueAtTime(0, start);
  master.gain.linearRampToValueAtTime(PEAK, start + RAMP);
  master.gain.setValueAtTime(PEAK, end - RAMP);
  master.gain.linearRampToValueAtTime(0, end);
  for (const hz of FREQUENCIES) {
    const osc = ctx.createOscillator();
    osc.frequency.value = hz;
    osc.connect(master);
    osc.start(start);
    osc.stop(end + RAMP);
    live.add(osc);
    osc.onended = (): void => void live.delete(osc);
  }
}

export function startRing(): void {
  if (timer !== null) return;
  const current = getEngine();
  if (current === null) return;
  resume(current.ctx);
  burst(current);
  timer = window.setInterval(() => burst(current), CYCLE_MS);
}

/** Silences at once with a short release, so there is no click. */
export function stopRing(): void {
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
