// src/hooks/useQueueProcessing.ts - Automated queue processing logic

import { useEffect, useRef } from 'react';
import type { QueueItem } from '../electron.d';
import { getErrorMessage } from '../types/errors';

interface UseQueueProcessingOptions {
  queue: QueueItem[];
  isQueueStarted: boolean;
  isQueueStopping: boolean;
  isProcessingQueueItem: boolean;
  isProcessingQueue: boolean;
  isProcessing: boolean;
  upscaleProgress: { percentage?: number } | null;
  setIsProcessingQueue: (processing: boolean) => void;
  setIsProcessingQueueItem: (processing: boolean) => void;
  setIsQueueStarted: (started: boolean) => void;
  setVideoInfo: (info: any) => void;
  setOutputPath: (path: string) => void;
  updateQueueItem: (id: string, updates: Partial<QueueItem>) => void;
  getNextPendingItem: () => QueueItem | null;
  onLog: (message: string) => void;
}

export function useQueueProcessing(options: UseQueueProcessingOptions) {
  const {
    queue,
    isQueueStarted,
    isQueueStopping,
    isProcessingQueueItem,
    isProcessingQueue,
    isProcessing,
    upscaleProgress,
    setIsProcessingQueue,
    setIsProcessingQueueItem,
    setIsQueueStarted,
    setVideoInfo,
    setOutputPath,
    updateQueueItem,
    getNextPendingItem,
    onLog,
  } = options;

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
      
      try {
        // Load video info and set output path for this item
        const info = await window.electronAPI.getVideoInfo(nextItem.videoPath);
        setVideoInfo(info);
        setOutputPath(nextItem.outputPath);
        onLog(`Loaded queue item: ${nextItem.videoName}`);
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
          nextItem.workflow.useDirectML,
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
        // Clear flag to allow next item to process
        setIsProcessingQueueItem(false);
      }
    };

    // Try to process next item when queue changes or item finishes processing
    if (isQueueStarted && !isProcessingQueueItem && !isQueueStopping) {
      processNextInQueue();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, isProcessingQueueItem, isProcessingQueue, isQueueStarted, isQueueStopping]);

  // Update queue item progress based on upscale progress
  // Throttle progress updates to prevent excessive re-renders
  const lastProgressUpdateRef = useRef<number>(0);
  const lastProgressValueRef = useRef<number>(0);
  
  useEffect(() => {
    if (isProcessing && isProcessingQueue && upscaleProgress) {
      const processingItem = queue.find(item => item.status === 'processing');
      if (processingItem && upscaleProgress.percentage !== undefined) {
        const now = Date.now();
        const progressDiff = Math.abs(upscaleProgress.percentage - lastProgressValueRef.current);
        
        // Only update if:
        // 1. At least 1 second has passed since last update, OR
        // 2. Progress has changed by at least 5%, OR
        // 3. Progress is 100% (completion)
        if (now - lastProgressUpdateRef.current >= 1000 || 
            progressDiff >= 5 || 
            upscaleProgress.percentage === 100) {
          lastProgressUpdateRef.current = now;
          lastProgressValueRef.current = upscaleProgress.percentage;
          updateQueueItem(processingItem.id, { progress: upscaleProgress.percentage });
        }
      }
    }
  }, [upscaleProgress, isProcessing, isProcessingQueue, queue, updateQueueItem]);
}
