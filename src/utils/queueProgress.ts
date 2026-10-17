// src/utils/queueProgress.ts - How often a running queue item's progress is written to the queue.

/** The last progress written: when, and how far along. */
export interface RecordedProgress {
  at: number;
  percentage: number;
}

/**
 * Whether percentage is worth writing to the running item: a second after the
 * last write, 5% past it, or the finish. Anything more often re-renders (and
 * re-saves) the queue for every frame.
 */
export function shouldRecordProgress(percentage: number, last: RecordedProgress, now: number): boolean {
  return now - last.at >= 1000
    || Math.abs(percentage - last.percentage) >= 5
    || percentage === 100;
}
