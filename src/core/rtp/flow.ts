/*
 * Decisions about the health and the destination of an RTP flow. Pure: the
 * session feeds in observations (a tick, a packet) and acts on the answer.
 */

import { sequenceDelta } from './packet';

export interface Endpoint {
  readonly host: string;
  readonly port: number;
}

const sameEndpoint = (a: Endpoint, b: Endpoint): boolean => a.host === b.host && a.port === b.port;

/* ------------------------------------------------------------- watchdog */

/** 20 ms, the session tick. */
export const TICK_MS = 20;
/**
 * No inbound RTP packet for this long on an established call is reported. 30 s
 * is long enough to ride out a Wi-Fi roam, a NAT rebind or a busy server, and
 * short enough that nobody stays on a dead call for long. Asterisk's
 * `rtp_timeout` is the same idea (off by default; deployments pick 30-60 s).
 * It counts PACKETS, never sound: a silent far end still sends them.
 */
export const INBOUND_TIMEOUT_MS = 30_000;

export interface WatchdogState {
  /** Consecutive ticks without an inbound packet. */
  readonly quiet: number;
  readonly alarmed: boolean;
}

export type WatchdogEvent = 'stalled' | 'resumed';

export interface WatchdogStep {
  readonly state: WatchdogState;
  readonly event?: WatchdogEvent;
}

export const WATCHDOG_START: WatchdogState = { quiet: 0, alarmed: false };

export const timeoutTicks = (timeoutMs: number): number => Math.max(1, Math.ceil(timeoutMs / TICK_MS));

/** One tick elapsed with nothing heard. `stalled` is raised once, on the tick that reaches the limit. */
export function watchdogTick(state: WatchdogState, limitTicks: number): WatchdogStep {
  const quiet = state.quiet + 1;
  if (state.alarmed || quiet < limitTicks) return { state: { quiet, alarmed: state.alarmed } };
  return { state: { quiet, alarmed: true }, event: 'stalled' };
}

/** A packet arrived. `resumed` is raised only if the alarm had been raised. */
export function watchdogHeard(state: WatchdogState): WatchdogStep {
  return state.alarmed ? { state: WATCHDOG_START, event: 'resumed' } : { state: WATCHDOG_START };
}

/* -------------------------------------------------------------- latching */

/** 10 s: NAT-traversal media starts within a second of the answer; after that, leave the destination alone. */
export const LATCH_WINDOW_MS = 10_000;
/** Consecutive, in-sequence packets from one source and SSRC before we believe it. */
export const LATCH_CONFIRMATIONS = 5;

export interface Observation {
  readonly source: Endpoint;
  readonly ssrc: number;
  readonly sequence: number;
}

interface Candidate extends Observation {
  readonly count: number;
}

export interface LatchState {
  /** Where outbound media goes: the SDP address until a latch replaces it. */
  readonly target: Endpoint;
  /** True once the target is proven (it delivered audio, or we latched) or the window has closed. */
  readonly settled: boolean;
  readonly age: number;
  readonly candidate?: Candidate;
}

export const latchStart = (target: Endpoint): LatchState => ({ target, settled: false, age: 0 });

/** One tick of the call's life; the window closes after `windowTicks`. */
export function latchTick(state: LatchState, windowTicks: number): LatchState {
  const age = state.age + 1;
  return { ...state, age, settled: state.settled || age >= windowTicks };
}

const follows = (candidate: Candidate, next: Observation): boolean =>
  sameEndpoint(candidate.source, next.source) &&
  candidate.ssrc === next.ssrc &&
  sequenceDelta(next.sequence, candidate.sequence) === 1;

function advance(state: LatchState, seen: Observation): LatchState {
  const { candidate } = state;
  const count = candidate !== undefined && follows(candidate, seen) ? candidate.count + 1 : 1;
  if (count < LATCH_CONFIRMATIONS) return { ...state, candidate: { ...seen, count } };
  return { target: seen.source, settled: true, age: state.age };
}

/**
 * The latching rule. A packet's source replaces the target only when ALL hold:
 *  1. the target has not yet delivered audio and the window is still open
 *     (never latch away from an address that works, or late in the call);
 *  2. the source differs from the target;
 *  3. LATCH_CONFIRMATIONS packets in a row came from that one source, with one
 *     SSRC and consecutive sequence numbers (a stray or spoofed packet restarts
 *     the count instead of counting toward it).
 * A packet from the target itself settles the state for good.
 */
export function latchObserve(state: LatchState, seen: Observation): LatchState {
  if (state.settled) return state;
  if (sameEndpoint(seen.source, state.target)) return { target: state.target, settled: true, age: state.age };
  return advance(state, seen);
}
