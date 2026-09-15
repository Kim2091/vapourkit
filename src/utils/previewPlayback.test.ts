import { describe, it, expect, vi } from 'vitest';
import { PlaybackPacer, type PacerClock, type PlaybackStats } from './previewPlayback';

interface TestFrame { stream: number; n: number }

/**
 * A clock the test drives by hand. `schedule` queues one callback the way rAF
 * does; `advance` moves time and fires whatever is pending, so a test can say
 * "sixty ticks of 16.7ms" without waiting a second.
 */
function fakeClock() {
  let t = 0;
  let pending: (() => void) | null = null;
  let nextHandle = 1;
  const clock: PacerClock = {
    now: () => t,
    schedule: (fn) => { pending = fn; return nextHandle++; },
    cancel: () => { pending = null; },
  };
  return {
    clock,
    get time() { return t; },
    /** One display tick of `ms`. */
    tick(ms: number) {
      t += ms;
      const fn = pending;
      pending = null;
      fn?.();
    },
    ticks(count: number, ms: number) {
      for (let i = 0; i < count; i++) this.tick(ms);
    },
  };
}

function harness(fps: number) {
  const clock = fakeClock();
  const presented: TestFrame[] = [];
  const credits: number[] = [];
  const stats: PlaybackStats[] = [];
  const ends: (TestFrame | null)[] = [];
  const pacer = new PlaybackPacer<TestFrame>(clock.clock);
  const callbacks = {
    onPresent: (f: TestFrame) => { presented.push(f); },
    onCredit: (c: number) => { credits.push(c); },
    onStats: (s: PlaybackStats) => { stats.push(s); },
    onEnd: (f: TestFrame | null) => { ends.push(f); },
  };
  return { clock, presented, credits, stats, ends, pacer, callbacks, fps };
}

const DISPLAY_60HZ = 1000 / 60;

describe('PlaybackPacer', () => {
  it('holds 23.976 on a 60Hz display', () => {
    const h = harness(23.976);
    h.pacer.start(1, 23.976, h.callbacks);
    // Plenty of frames queued, so the chain is never the limit.
    for (let n = 0; n < 200; n++) h.pacer.push({ stream: 1, n });

    h.clock.ticks(120, DISPLAY_60HZ); // two seconds
    // Two seconds at 23.976 is ~48 frames. The first plays immediately, and a
    // frame can land up to one display tick late, so allow a little slack.
    expect(h.presented.length).toBeGreaterThanOrEqual(47);
    expect(h.presented.length).toBeLessThanOrEqual(50);
    // In order, none skipped: the queue always had frames ready.
    expect(h.presented.map(f => f.n)).toEqual(
      h.presented.map((_, i) => i),
    );
  });

  it('plays every frame in order when the chain runs far under target', () => {
    const h = harness(23.976);
    h.pacer.start(1, 23.976, h.callbacks);

    // One frame every ~333ms: a 3 fps chain against a 24 fps target.
    for (let i = 0; i < 10; i++) {
      h.pacer.push({ stream: 1, n: i });
      h.clock.ticks(20, DISPLAY_60HZ);
    }

    // Every frame shown, none dropped to chase wall-clock.
    expect(h.presented.map(f => f.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(h.stats.at(-1)?.displayDropped).toBe(0);
  });

  it('reports behind rather than silently running slow', () => {
    const h = harness(23.976);
    h.pacer.start(1, 23.976, h.callbacks);

    for (let i = 0; i < 12; i++) {
      h.pacer.push({ stream: 1, n: i });
      h.clock.ticks(20, DISPLAY_60HZ); // ~333ms per frame
    }

    const last = h.stats.at(-1)!;
    expect(last.behind).toBe(true);
    expect(last.achievedFps).toBeLessThan(10);
    expect(last.targetFps).toBeCloseTo(23.976, 2);
  });

  it('does not burst through a backlog after a stall', () => {
    const h = harness(23.976);
    h.pacer.start(1, 23.976, h.callbacks);
    h.pacer.push({ stream: 1, n: 0 });
    h.clock.tick(DISPLAY_60HZ);
    expect(h.presented).toHaveLength(1);

    // Half a second of nothing, then the chain catches up all at once.
    h.clock.ticks(30, DISPLAY_60HZ);
    for (let n = 1; n <= 12; n++) h.pacer.push({ stream: 1, n });

    // One display tick after the backlog lands, at most one frame is shown —
    // not the whole queue.
    const before = h.presented.length;
    h.clock.tick(DISPLAY_60HZ);
    expect(h.presented.length - before).toBe(1);
  });

  it('presents the newer frame when the output outruns the display', () => {
    const h = harness(120);
    h.pacer.start(1, 120, h.callbacks);
    for (let n = 0; n < 60; n++) h.pacer.push({ stream: 1, n });

    h.clock.ticks(30, DISPLAY_60HZ); // half a second of 60Hz ticks

    // 120fps content on a 60Hz display: about half the frames can never be
    // painted, and the pacer says so rather than falling behind.
    expect(h.stats.at(-1)!.displayDropped).toBeGreaterThan(10);
    // Whatever it painted moved forward monotonically.
    const shown = h.presented.map(f => f.n);
    expect([...shown].sort((a, b) => a - b)).toEqual(shown);
  });

  it('credits every frame it consumes, including ones it could not paint', () => {
    const h = harness(120);
    h.pacer.start(1, 120, h.callbacks);
    for (let n = 0; n < 40; n++) h.pacer.push({ stream: 1, n });
    h.clock.ticks(20, DISPLAY_60HZ);

    // Stats are throttled, so the drop count is a sample that can predate the
    // last frames to leave the queue. Tick on until a fresh one lands — it is
    // emitted after that tick presented, so the two agree.
    const seen = h.stats.length;
    while (h.stats.length === seen) h.clock.tick(DISPLAY_60HZ);

    const granted = h.credits.reduce((sum, c) => sum + c, 0);
    const consumed = h.presented.length + h.stats.at(-1)!.displayDropped;
    // A frame dropped for the display still left the queue, so the producer
    // is owed room for it — otherwise the chain stalls behind a display limit.
    expect(granted).toBe(consumed);
  });

  it('drops frames from a superseded stream', () => {
    const h = harness(23.976);
    h.pacer.start(7, 23.976, h.callbacks);

    expect(h.pacer.push({ stream: 6, n: 100 })).toBe(false);
    expect(h.pacer.push({ stream: 7, n: 0 })).toBe(true);
    h.clock.ticks(4, DISPLAY_60HZ);

    expect(h.presented.map(f => f.n)).toEqual([0]);
  });

  it('starts a new stream without leaking the old queue', () => {
    const h = harness(23.976);
    h.pacer.start(1, 23.976, h.callbacks);
    for (let n = 0; n < 10; n++) h.pacer.push({ stream: 1, n });

    h.pacer.start(2, 23.976, h.callbacks);
    h.pacer.push({ stream: 2, n: 500 });
    h.clock.ticks(4, DISPLAY_60HZ);

    expect(h.presented.map(f => f.n)).toEqual([500]);
  });

  it('reports starving while the queue is empty', () => {
    const h = harness(23.976);
    h.pacer.start(1, 23.976, h.callbacks);
    h.clock.ticks(40, DISPLAY_60HZ);

    expect(h.stats.at(-1)?.starving).toBe(true);
    expect(h.presented).toHaveLength(0);
  });

  it('ends once the queue drains, handing back the last frame shown', () => {
    const h = harness(23.976);
    h.pacer.start(1, 23.976, h.callbacks);
    h.pacer.push({ stream: 1, n: 40 });
    h.pacer.push({ stream: 1, n: 41 });
    h.pacer.end(1);

    h.clock.ticks(30, DISPLAY_60HZ);

    expect(h.presented.map(f => f.n)).toEqual([40, 41]);
    expect(h.ends).toEqual([{ stream: 1, n: 41 }]);
    expect(h.pacer.isRunning).toBe(false);
  });

  it('stops ticking after stop, so a closed session spends nothing', () => {
    const h = harness(23.976);
    const cancel = vi.spyOn(h.clock.clock, 'cancel');
    h.pacer.start(1, 23.976, h.callbacks);
    h.pacer.push({ stream: 1, n: 0 });
    h.clock.tick(DISPLAY_60HZ);

    h.pacer.stop();
    h.clock.ticks(10, DISPLAY_60HZ);

    expect(cancel).toHaveBeenCalled();
    expect(h.presented).toHaveLength(1);
    expect(h.pacer.isRunning).toBe(false);
  });
});
