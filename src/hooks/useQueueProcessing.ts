// src/hooks/useQueueProcessing.ts - Automated queue processing logic

import { useEffect, useRef } from 'react';
import type { QueueItem } from '../electron.d';
import { getErrorMessage } from '../types/errors';
import { shouldRecordProgress, type RecordedProgress } from '../utils/queueProgress';
import { nextRunStep, type QueueRunStatus } from '../utils/queueRun';

interface UseQueueProcessingOptions {
  queue: QueueItem[];
  runStatus: QueueRunStatus;
  setRunStatus: (status: QueueRunStatus) => void;
  /** The item rendering. The runner keeps it to itself: the window goes on showing whatever is being edited. */
  runningItemId: string | null;
  setRunningItemId: (id: string | null) => void;
  upscaleProgress: { percentage?: number } | null;
  updateQueueItem: (id: string, updates: Partial<QueueItem>) => void;
  /**
   * Put an item's render settings in the config, which the main process reads
   * them from, before it renders; resolves once they are written.
   */
  beginItemRender: (workflow: QueueItem['workflow']) => Promise<void>;
  /** Give the config back to the window's settings. */
  endItemRender: () => void;
  onLog: (message: string) => void;
}

export function useQueueProcessing(options: UseQueueProcessingOptions) {
  const {
    queue,
    runStatus,
    setRunStatus,
    runningItemId,
    setRunningItemId,
    upscaleProgress,
    updateQueueItem,
    beginItemRender,
    endItemRender,
    onLog,
  } = options;

  // The status as of now, for a render that ends after Stop was pressed.
  const runStatusRef = useRef(runStatus);
  runStatusRef.current = runStatus;

  const recordedProgressRef = useRef<RecordedProgress>({ at: 0, percentage: 0 });
  // The last progress event seen, so an item that starts is not given the
  // one its predecessor finished on.
  const seenProgressRef = useRef(upscaleProgress);

  // One item at a time, in queue order, until none is pending.
  useEffect(() => {
    const step = nextRunStep(runStatus, runningItemId, queue);
    if (step.kind === 'wait') return;
    if (step.kind === 'finish') {
      setRunStatus('idle');
      onLog('=== Queue processing completed ===');
      return;
    }

    const nextItem = step.item;
    setRunningItemId(nextItem.id);
    updateQueueItem(nextItem.id, { status: 'processing', progress: 0 });
    recordedProgressRef.current = { at: 0, percentage: 0 };

    void (async () => {
      try {
        await beginItemRender(nextItem.workflow);
        onLog(`Output will be: ${nextItem.outputPath}`);
        onLog(`Processing queue item: ${nextItem.videoName}`);
        if (nextItem.workflow.segment?.enabled) {
          onLog(`Segment: frames ${nextItem.workflow.segment.startFrame} to ${nextItem.workflow.segment.endFrame === -1 ? 'end' : nextItem.workflow.segment.endFrame}`);
        }
        const result = await window.electronAPI.startUpscale(
          nextItem.videoPath,
          nextItem.workflow.selectedModel || '',
          nextItem.outputPath,
          nextItem.workflow.defaultBackend,
          true,
          nextItem.workflow.filters,
          0,
          nextItem.workflow.numStreams,
          nextItem.workflow.segment
        );

        if (!result.success) {
          throw new Error(result.error || 'Processing failed');
        }

        updateQueueItem(nextItem.id, {
          status: 'completed',
          progress: 100,
          completedAt: new Date().toISOString(),
        });
        onLog(`Completed: ${nextItem.videoName}`);
      } catch (error) {
        // Stopping the queue cancels the render and puts the item back to
        // pending; the failure that cancel causes is not the item's.
        if (runStatusRef.current === 'running') {
          updateQueueItem(nextItem.id, {
            status: 'error',
            errorMessage: getErrorMessage(error),
          });
        }
        onLog(`Error processing ${nextItem.videoName}: ${getErrorMessage(error)}`);
      } finally {
        endItemRender();
        // Only now, after Stop too: a new run waits for this render to end.
        setRunningItemId(null);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, runStatus, runningItemId]);

  // The running item's progress, from the render's progress events.
  useEffect(() => {
    if (upscaleProgress === seenProgressRef.current) return;
    seenProgressRef.current = upscaleProgress;
    const percentage = upscaleProgress?.percentage;
    if (!runningItemId || percentage === undefined) return;
    const now = Date.now();
    if (shouldRecordProgress(percentage, recordedProgressRef.current, now)) {
      recordedProgressRef.current = { at: now, percentage };
      updateQueueItem(runningItemId, { progress: percentage });
    }
  }, [upscaleProgress, runningItemId, updateQueueItem]);
}
