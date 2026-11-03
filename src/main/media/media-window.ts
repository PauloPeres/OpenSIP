/*
 * Main-process side of the audio bridge. It owns the lifecycle of the hidden
 * media window (created lazily, recreated if it dies) and moves 20 ms PCM
 * frames to and from it. It has no Electron import: the window and the IPC
 * listener are injected, which is what lets media-bridge.spec.ts exercise it.
 */
import { MEDIA_FRAME_SAMPLES, MEDIA_IPC, toPcmFrame } from '../../shared/media';

export interface MediaWindowHandle {
  send(channel: string, ...args: unknown[]): void;
  isDestroyed(): boolean;
  /** True when `sender` is this window's own web contents. */
  owns(sender: unknown): boolean;
  /** Settles once the page has loaded and its preload listeners exist. */
  readonly ready: Promise<void>;
  onClosed(listener: () => void): void;
  destroy(): void;
}

export interface MediaBridgeDeps {
  createWindow(): MediaWindowHandle;
  listen(channel: string, handler: (sender: unknown, ...args: unknown[]) => void): () => void;
  log(message: string): void;
}

export type CaptureListener = (callId: string, samples: Int16Array) => void;

export interface MediaBridge {
  /** Opens the microphone and speaker for a call. */
  start(callId: string): void;
  stop(callId: string): void;
  /** One decoded 20 ms frame for the speaker. Dropped while the window is not ready. */
  play(callId: string, samples: Int16Array): void;
  /** One 20 ms frame from the microphone. */
  onCapture(listener: CaptureListener): () => void;
  dispose(): void;
}

interface Message {
  readonly channel: string;
  readonly args: readonly unknown[];
}

class Bridge implements MediaBridge {
  private readonly deps: MediaBridgeDeps;
  private readonly active = new Set<string>();
  private readonly listeners = new Set<CaptureListener>();
  private readonly stopListening: () => void;
  private window: MediaWindowHandle | undefined;
  private ready = false;
  private pending: Message[] = [];

  constructor(deps: MediaBridgeDeps) {
    this.deps = deps;
    const offCapture = deps.listen(MEDIA_IPC.capture, (sender, callId, data) =>
      this.onCaptured(sender, callId, data)
    );
    const offError = deps.listen(MEDIA_IPC.error, (sender, callId, message) =>
      this.onReported(sender, callId, message)
    );
    this.stopListening = (): void => {
      offCapture();
      offError();
    };
  }

  start(callId: string): void {
    this.control(MEDIA_IPC.start, callId);
    this.active.add(callId);
  }

  stop(callId: string): void {
    if (!this.active.delete(callId)) return;
    this.control(MEDIA_IPC.stop, callId);
  }

  play(callId: string, samples: Int16Array): void {
    if (!this.active.has(callId) || samples.length !== MEDIA_FRAME_SAMPLES) return;
    const window = this.ensureWindow();
    if (this.ready) this.deliver(window, { channel: MEDIA_IPC.playback, args: [callId, samples] });
  }

  onCapture(listener: CaptureListener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  dispose(): void {
    this.stopListening();
    this.window?.destroy();
    this.window = undefined;
    this.ready = false;
    this.pending = [];
    this.listeners.clear();
    this.active.clear();
  }

  /** Start and stop requests are never dropped: they wait for the page if it is still loading. */
  private control(channel: string, callId: string): void {
    const window = this.ensureWindow();
    const message: Message = { channel, args: [callId] };
    if (this.ready) this.deliver(window, message);
    else this.pending.push(message);
  }

  private ensureWindow(): MediaWindowHandle {
    const current = this.window;
    return current !== undefined && !current.isDestroyed() ? current : this.open();
  }

  /** A fresh window knows nothing, so every stream that is still live is started again. */
  private open(): MediaWindowHandle {
    const window = this.deps.createWindow();
    this.window = window;
    this.ready = false;
    this.pending = [...this.active].map((id) => ({ channel: MEDIA_IPC.start, args: [id] }));
    window.onClosed(() => this.forget(window));
    window.ready.then(
      () => this.onReady(window),
      (error: unknown) => this.onLoadFailed(window, error)
    );
    return window;
  }

  private forget(window: MediaWindowHandle): void {
    if (this.window !== window) return;
    this.window = undefined;
    this.ready = false;
    this.pending = [];
  }

  private onReady(window: MediaWindowHandle): void {
    if (this.window !== window) return;
    this.ready = true;
    const queued = this.pending;
    this.pending = [];
    for (const message of queued) this.deliver(window, message);
  }

  private onLoadFailed(window: MediaWindowHandle, error: unknown): void {
    this.deps.log(`media window failed to load: ${error instanceof Error ? error.message : String(error)}`);
    this.forget(window);
    window.destroy();
  }

  private deliver(window: MediaWindowHandle, message: Message): void {
    try {
      window.send(message.channel, ...message.args);
    } catch (error) {
      this.deps.log(`media window send failed: ${String(error)}`);
    }
  }

  private onReported(sender: unknown, callId: unknown, message: unknown): void {
    if (this.window === undefined || !this.window.owns(sender)) return;
    this.deps.log(`media window, call ${String(callId).slice(0, 64)}: ${String(message).slice(0, 200)}`);
  }

  private onCaptured(sender: unknown, callId: unknown, data: unknown): void {
    if (this.window === undefined || !this.window.owns(sender)) return;
    if (typeof callId !== 'string' || !this.active.has(callId)) return;
    const samples = toPcmFrame(data);
    if (samples === undefined) return;
    for (const listener of [...this.listeners]) this.notify(listener, callId, samples);
  }

  private notify(listener: CaptureListener, callId: string, samples: Int16Array): void {
    try {
      listener(callId, samples);
    } catch (error) {
      this.deps.log(`capture listener failed: ${String(error)}`);
    }
  }
}

export function createMediaBridge(deps: MediaBridgeDeps): MediaBridge {
  return new Bridge(deps);
}
