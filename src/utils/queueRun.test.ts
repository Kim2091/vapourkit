import { describe, it, expect } from 'vitest';
import { nextRunStep, queueRunFlags } from './queueRun';
import type { QueueItem } from '../electron.d';

const item = (id: string, status: QueueItem['status']): QueueItem => ({
  id,
  videoPath: `${id}.mp4`,
  videoName: `${id}.mp4`,
  outputPath: `${id}-out.mkv`,
  status,
  addedAt: '',
  workflow: {
    selectedModel: null, filters: [], ffmpegArgs: '', processingFormat: '', outputFormat: 'mkv',
    videoCompareArgs: '', defaultBackend: 'tensorrt', numStreams: 2,
  },
});

describe('queueRunFlags', () => {
  it('derives the panel flags from the status and the running item', () => {
    expect(queueRunFlags('idle', null)).toEqual({ isQueueStarted: false, isQueueStopping: false, isProcessingQueueItem: false });
    expect(queueRunFlags('running', 'a')).toEqual({ isQueueStarted: true, isQueueStopping: false, isProcessingQueueItem: true });
    expect(queueRunFlags('stopping', 'a')).toEqual({ isQueueStarted: true, isQueueStopping: true, isProcessingQueueItem: true });
  });
});

describe('nextRunStep', () => {
  const queue = [item('a', 'completed'), item('b', 'pending'), item('c', 'pending')];

  it('starts the first pending item', () => {
    expect(nextRunStep('running', null, queue)).toEqual({ kind: 'start', item: queue[1] });
  });

  it('waits while an item renders, and does nothing unless running', () => {
    expect(nextRunStep('running', 'b', queue)).toEqual({ kind: 'wait' });
    expect(nextRunStep('stopping', null, queue)).toEqual({ kind: 'wait' });
    expect(nextRunStep('idle', null, queue)).toEqual({ kind: 'wait' });
  });

  it('finishes when nothing is left', () => {
    expect(nextRunStep('running', null, [item('a', 'completed'), item('b', 'error')])).toEqual({ kind: 'finish' });
  });
});
