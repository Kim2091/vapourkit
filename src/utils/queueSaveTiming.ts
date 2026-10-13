// src/utils/queueSaveTiming.ts — when the queue's debounced save should run.
//
// The queue is saved a little after it changes, so a burst of edits is one
// write. But while it processes, the progress of the running item changes it
// about once a second, and a plain debounce that restarts on every change
// never fired: nothing was saved for the whole run, and a crash put every
// finished item back to pending. So the wait is capped, and a change to what
// the queue holds (an item added, removed, moved, or finishing) is saved at
// once, since those are the changes a crash must not lose.

import type { QueueItem } from '../electron.d';

/** Quiet time that lets a burst of edits become one write. */
export const QUEUE_SAVE_DEBOUNCE_MS = 2000;
/** The longest a change may wait, however often the queue keeps changing. */
export const QUEUE_SAVE_MAX_WAIT_MS = 10000;

/** What a save must not lose: which items there are, in what order, in what state. */
export function queueShape(queue: Pick<QueueItem, 'id' | 'status'>[]): string {
  return queue.map(item => `${item.id}:${item.status}`).join('|');
}

/**
 * Milliseconds to wait before saving.
 *
 * @param shapeChanged whether this change altered queueShape
 * @param pendingSince when the oldest unsaved change was made
 */
export function queueSaveDelay(shapeChanged: boolean, pendingSince: number, now: number): number {
  if (shapeChanged) return 0;
  const untilCap = pendingSince + QUEUE_SAVE_MAX_WAIT_MS - now;
  return Math.max(0, Math.min(QUEUE_SAVE_DEBOUNCE_MS, untilCap));
}
