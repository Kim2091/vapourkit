// src/utils/previewPlayback.ts — the clock for chain playback.
//
// The renderer owns pacing, not the python server. Presentation time is a
// renderer fact, and driving the tick from requestAnimationFrame means a
// hidden window stops ticking, stops spending credits, and lets the chain go
// idle on its own.
//
// The rule when the chain cannot keep up: play every frame it produces, in
// order, however slowly they arrive. Never skip a chain frame to hold
// wall-clock. Playback exists to answer whether a step looks right in motion
// — combing, flicker, cadence, ghosting — and every one of those is a
// property of consecutive frames. Dropping frames to keep time destroys the
// evidence and leaves you judging a slideshow of the frames that survived.
// The readout says what rate was actually reached; the picture stays honest.
//
// The one exception is a frame the display physically cannot show: when the
// output runs faster than the refresh rate, two frames fall due inside one
// tick and only the newer can be painted. That is counted separately.

/** The minimum a frame needs for the pacer to route it. */
export interface PacedFrame {
  stream: number;
  n: number;
}

export interface PlaybackStats {
  /** The rate this output should play at. */
  targetFps: number;
  /** What was actually reached, once enough frames have been shown. */
  achievedFps: number | null;
  /** Sustained under target — the chain is the limit, not the clock. */
  behind: boolean;
  /** Nothing queued: waiting on the chain. */
  starving: boolean;
  /** Frames delivered but never painted, because the display had no tick. */
  displayDropped: number;
}

/** rAF and performance.now, injected so the pacer tests on a fake clock. */
export interface PacerClock {
  now(): number;
  schedule(fn: () => void): number;
  cancel(handle: number): void;
}

export interface PacerCallbacks<F extends PacedFrame> {
  onPresent(frame: F): void;
  /** Frames consumed, so the producer may send that many more. */
  onCredit(count: number): void;
  onStats(stats: PlaybackStats): void;
  /** The clip ran out and the queue has drained. */
  onEnd?(lastFrame: F | null): void;
}

const STATS_INTERVAL_MS = 250;
/** How long under target before saying so, so a single slow frame is quiet. */
const BEHIND_AFTER_MS = 1000;
/** Weight of each new interval in the achieved-rate average. */
const RATE_SMOOTHING = 0.2;

export function defaultPacerClock(): PacerClock {
  return {
    now: () => performance.now(),
    schedule: (fn) => requestAnimationFrame(fn),
    cancel: (handle) => cancelAnimationFrame(handle),
  };
}

export class PlaybackPacer<F extends PacedFrame> {
  private readonly clock: PacerClock;

  private stream = -1;
  private frameMs = 0;
  private targetFps = 0;
  private callbacks: PacerCallbacks<F> | null = null;

  private queue: F[] = [];
  private handle: number | null = null;
  private nextDue: number | null = null;
  private lastPresentAt: number | null = null;
  private lastPresented: F | null = null;
  private meanIntervalMs: number | null = null;
  private displayDropped = 0;
  private behindSince: number | null = null;
  private lastStatsAt = 0;
  private ended = false;

  constructor(clock: PacerClock = defaultPacerClock()) {
    this.clock = clock;
  }

  get isRunning(): boolean {
    return this.callbacks !== null;
  }

  /** The stream currently being paced, or -1 when stopped. */
  get currentStream(): number {
    return this.stream;
  }

  start(stream: number, fps: number, callbacks: PacerCallbacks<F>): void {
    this.stop();
    this.stream = stream;
    this.targetFps = fps > 0 ? fps : 24;
    this.frameMs = 1000 / this.targetFps;
    this.callbacks = callbacks;
    this.queue = [];
    this.nextDue = null;
    this.lastPresentAt = null;
    this.lastPresented = null;
    this.meanIntervalMs = null;
    this.displayDropped = 0;
    this.behindSince = null;
    this.lastStatsAt = this.clock.now();
    this.ended = false;
    this.tick();
  }

  stop(): void {
    if (this.handle !== null) {
      this.clock.cancel(this.handle);
      this.handle = null;
    }
    this.callbacks = null;
    this.queue = [];
    this.stream = -1;
  }

  /**
   * Queue a delivered frame. Frames from a superseded stream are dropped
   * here — a step switch or a seek starts a new stream, and whatever was
   * already in the pipe for the old one would paint the wrong step.
   */
  push(frame: F): boolean {
    if (!this.callbacks || frame.stream !== this.stream) return false;
    this.queue.push(frame);
    return true;
  }

  /** The clip ran out. Play what is queued, then report the end. */
  end(stream: number): void {
    if (stream !== this.stream) return;
    this.ended = true;
  }

  private tick = (): void => {
    if (!this.callbacks) return;
    const now = this.clock.now();

    if (this.queue.length > 0) {
      this.present(now);
    } else if (this.ended) {
      const callbacks = this.callbacks;
      const last = this.lastPresented;
      this.stop();
      callbacks.onEnd?.(last);
      return;
    }

    this.emitStats(now, this.queue.length === 0 && !this.ended);
    this.handle = this.clock.schedule(this.tick);
  };

  private present(now: number): void {
    const callbacks = this.callbacks;
    if (!callbacks) return;

    // The first frame plays the moment it arrives; the schedule starts there.
    if (this.nextDue === null) this.nextDue = now;
    if (now < this.nextDue) return;

    // Frames that fell due while the display had no tick for them. Only
    // reachable when the output runs faster than the refresh rate, because it
    // needs frames already queued behind the one that is due.
    const overdue = Math.floor((now - this.nextDue) / this.frameMs);
    const skipped = this.queue.length > 1
      ? Math.min(overdue, this.queue.length - 1)
      : 0;
    if (skipped > 0) {
      this.queue.splice(0, skipped);
      this.displayDropped += skipped;
    }

    const frame = this.queue.shift()!;
    this.lastPresented = frame;
    callbacks.onPresent(frame);
    // Credit covers the skipped frames too. They were delivered and are gone
    // from the queue, so the producer is owed room for them either way —
    // withholding it would stall the chain behind a display limit.
    callbacks.onCredit(skipped + 1);

    this.nextDue += this.frameMs * (skipped + 1);
    // Still behind after presenting means the frames were not there in time.
    // Re-base rather than firing the backlog off as fast as the display can
    // take it: a burst after a stall reads as a speed-up that is not in the
    // footage.
    if (this.nextDue <= now) this.nextDue = now + this.frameMs;

    if (this.lastPresentAt !== null) {
      const interval = now - this.lastPresentAt;
      this.meanIntervalMs = this.meanIntervalMs === null
        ? interval
        : this.meanIntervalMs + (interval - this.meanIntervalMs) * RATE_SMOOTHING;
    }
    this.lastPresentAt = now;
  }

  private emitStats(now: number, starving: boolean): void {
    const achieved = this.meanIntervalMs && this.meanIntervalMs > 0
      ? 1000 / this.meanIntervalMs
      : null;

    if (achieved !== null && achieved < this.targetFps * 0.9) {
      if (this.behindSince === null) this.behindSince = now;
    } else {
      this.behindSince = null;
    }
    const behind = this.behindSince !== null && now - this.behindSince >= BEHIND_AFTER_MS;

    if (now - this.lastStatsAt < STATS_INTERVAL_MS) return;
    this.lastStatsAt = now;
    this.callbacks?.onStats({
      targetFps: this.targetFps,
      achievedFps: achieved,
      behind,
      starving,
      displayDropped: this.displayDropped,
    });
  }
}
