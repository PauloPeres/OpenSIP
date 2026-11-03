/*
 * The audio bridge between the main process (RTP socket, G.711, jitter buffer)
 * and the hidden media window (microphone and speaker through Web Audio).
 *
 * Both directions carry one 20 ms frame per message: 160 signed 16-bit samples
 * at 8 kHz, as a typed array (never a JSON array of numbers).
 */

export const MEDIA_SAMPLE_RATE = 8000;
export const MEDIA_FRAME_SAMPLES = 160;
const MEDIA_FRAME_BYTES = MEDIA_FRAME_SAMPLES * Int16Array.BYTES_PER_ELEMENT;

/** Passed to the hidden window so the shared preload exposes only the media API there. */
export const MEDIA_WINDOW_ARGUMENT = '--opensip-media-window';

export const MEDIA_IPC = {
  /** main -> media window: (callId) open microphone and speaker for a call. */
  start: 'opensip:media:start',
  /** main -> media window: (callId) release them. */
  stop: 'opensip:media:stop',
  /** main -> media window: (callId, Int16Array[160]) a frame for the speaker. */
  playback: 'opensip:media:playback',
  /** media window -> main: (callId, Int16Array[160]) a frame from the microphone. */
  capture: 'opensip:media:capture',
  /** media window -> main: (callId, message) a microphone or playback problem, for the log. */
  error: 'opensip:media:error'
} as const;

/**
 * Accepts exactly one frame of binary PCM, as an Int16Array or as 320 raw bytes,
 * and returns a private, aligned copy. Anything else is rejected.
 */
export function toPcmFrame(value: unknown): Int16Array | undefined {
  if (value instanceof Int16Array) {
    return value.length === MEDIA_FRAME_SAMPLES ? value.slice() : undefined;
  }
  const view = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  if (!(view instanceof Uint8Array) || view.byteLength !== MEDIA_FRAME_BYTES) return undefined;
  return new Int16Array(view.slice().buffer);
}

export type Unsubscribe = () => void;

/** What the hidden window's preload exposes to its page as `window.opensipMedia`. */
export interface MediaPreloadApi {
  onStart(listener: (callId: string) => void): Unsubscribe;
  onStop(listener: (callId: string) => void): Unsubscribe;
  onPlayback(listener: (callId: string, samples: Int16Array) => void): Unsubscribe;
  sendCapture(callId: string, samples: Int16Array): void;
  reportError(callId: string, message: string): void;
}

declare global {
  interface Window {
    readonly opensipMedia: MediaPreloadApi;
  }
}
