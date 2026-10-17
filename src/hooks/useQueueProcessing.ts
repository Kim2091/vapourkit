// src/hooks/useQueueProcessing.ts - Automated queue processing logic

import { useEffect, useRef, useState } from 'react';
import type { QueueItem } from '../electron.d';
import { getErrorMessage } from '../types/errors';
import { shouldRecordProgress, type RecordedProgress } from '../utils/queueProgress';

interface UseQueueProcessingOptions {
  queue: QueueItem[];
  isQueueStarted: boolean;
  isQueueStopping: boolean;
  isProcessingQueueItem: boolean;
  isProcessingQueue: boolean;
  upscaleProgress: { percentage?: number } | null;
  setIsProcessingQueue: (processing: boolean) => void;
  setIsProcessingQueueItem: (processing: boolean) => void;
  setIsQueueStarted: (started: boolean) => void;
  updateQueueItem: (id: string, updates: Partial<QueueItem>) => void;
  getNextPendingItem: () => QueueItem | null;
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
    isQueueStarted,
    isQueueStopping,
    isProcessingQueueItem,
    isProcessingQueue,
    upscaleProgress,
    setIsProcessingQueue,
    setIsProcessingQueueItem,
    setIsQueueStarted,
    updateQueueItem,
    getNextPendingItem,
    beginItemRender,
    endItemRender,
    onLog,
  } = options;

  // The item being rendered. The runner keeps it to itself: the window goes
  // on showing whatever is being edited while the queue runs.
  const [runningItemId, setRunningItemId] = useState<string | null>(null);

  const recordedProgressRef = useRef<RecordedProgress>({ at: 0, percentage: 0 });
  // The last progress event seen, so an item that starts is not given the
  // one its predecessor finished on.
  const seenProgressRef = useRef(upscaleProgress);

  // Process queue sequentially
  useEffect(() => {
    const processNextInQueue = async () => {
      // Don't start new item if already processing one, queue hasn't been started, or is stopping
      if (isProcessingQueueItem || !isQueueStarted || isQueueStopping) return;
      
      const nextItem = getNextPendingItem();
      if (!nextItem) {
        // Queue finished
        if (isProcessingQueue) {
          setIsProcessingQueue(false);
          setIsQueueStarted(false);
          onLog('=== Queue processing completed ===');
        }
        return;
      }

      // Mark as processing queue
      if (!isProcessingQueue) {
        setIsProcessingQueue(true);
      }

      // Set flag to prevent processing multiple items at once
      setIsProcessingQueueItem(true);

      // Update item status to processing
      updateQueueItem(nextItem.id, { status: 'processing', progress: 0 });
      setRunningItemId(nextItem.id);
      recordedProgressRef.current = { at: 0, percentage: 0 };

      try {
        await beginItemRender(nextItem.workflow);
        onLog(`Output will be: ${nextItem.outputPath}`);
        
        // Start processing with the item's workflow
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
        
        // Mark as completed
        updateQueueItem(nextItem.id, {
          status: 'completed',
          progress: 100,
          completedAt: new Date().toISOString(),
        });
        onLog(`Completed: ${nextItem.videoName}`);
      } catch (error) {
        // Mark as error
        updateQueueItem(nextItem.id, {
          status: 'error',
          errorMessage: getErrorMessage(error),
        });
        onLog(`Error processing ${nextItem.videoName}: ${getErrorMessage(error)}`);
      } finally {
        endItemRender();
        // Clear flag to allow next item to process
        setRunningItemId(null);
        setIsProcessingQueueItem(false);
      }
    };

    // Try to process next item when queue changes or item finishes processing
    if (isQueueStarted && !isProcessingQueueItem && !isQueueStopping) {
      processNextInQueue();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, isProcessingQueueItem, isProcessingQueue, isQueueStarted, isQueueStopping]);

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
