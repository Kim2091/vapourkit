// src/utils/queueRun.ts - Where a queue run is, and what it does next.

import type { QueueItem } from '../electron.d';

/** Idle; running (one item at a time); or stopping, after Stop and until the running item has ended. */
export type QueueRunStatus = 'idle' | 'running' | 'stopping';

/** The flags the queue panel and action bar read. */
export function queueRunFlags(status: QueueRunStatus, runningItemId: string | null) {
  return {
    isQueueStarted: status !== 'idle',
    isQueueStopping: status === 'stopping',
    isProcessingQueueItem: runningItemId !== null,
  };
}

/** What a run does now: wait for the item rendering, start the next pending one, or finish. */
export function nextRunStep(
  status: QueueRunStatus,
  runningItemId: string | null,
  queue: QueueItem[],
): { kind: 'wait' } | { kind: 'start'; item: QueueItem } | { kind: 'finish' } {
  if (status !== 'running' || runningItemId !== null) return { kind: 'wait' };
  const item = queue.find(candidate => candidate.status === 'pending');
  return item ? { kind: 'start', item } : { kind: 'finish' };
}
