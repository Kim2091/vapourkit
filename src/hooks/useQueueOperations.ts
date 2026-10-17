// src/hooks/useQueueOperations.ts - Queue user operations: selecting, starting, stopping and opening items

import { useEffect } from 'react';
import type { QueueItem } from '../electron.d';
import { getErrorMessage } from '../types/errors';
import { onBeforeClose } from '../utils/beforeClose';

interface UseQueueOperationsOptions {
  queue: QueueItem[];
  /** Show a queue item's settings in the window; edits are saved to it when editable. */
  openItem: (id: string, workflow: QueueItem['workflow'], editable: boolean) => void;
  /** The edit still to save to the item being edited, for the save as the window closes. */
  pendingItemSave: () => { itemId: string; workflow: QueueItem['workflow'] } | undefined;
  isProcessingQueueItem: boolean;
  setIsQueueStarted: (started: boolean) => void;
  setIsProcessingQueue: (processing: boolean) => void;
  setIsProcessingQueueItem: (processing: boolean) => void;
  setIsQueueStopping: (stopping: boolean) => void;
  updateQueueItem: (id: string, updates: Partial<QueueItem>) => void;
  flushQueue: (pending?: { itemId: string; workflow: Partial<QueueItem['workflow']> }) => void;
  requeueItem: (id: string) => void;
  loadVideoInfo: (path: string) => Promise<unknown>;
  handleCancelUpscale: () => Promise<void>;
  onLog: (message: string) => void;
  loadCompletedVideo?: (path: string) => Promise<void>;
  setCompletedVideoPath?: (path: string | null) => void;
}

export function useQueueOperations(options: UseQueueOperationsOptions) {
  const {
    queue,
    openItem,
    pendingItemSave,
    isProcessingQueueItem,
    setIsQueueStarted,
    setIsProcessingQueue,
    setIsProcessingQueueItem,
    setIsQueueStopping,
    updateQueueItem,
    flushQueue,
    requeueItem,
    loadVideoInfo,
    handleCancelUpscale,
    onLog,
    loadCompletedVideo,
    setCompletedVideoPath,
  } = options;

  // The queue's own save waits up to a few seconds; closing the window inside
  // that dropped the last edits. Write it all now, with the edited item as the
  // document has it: a step's code still being typed is committed in the phase
  // before this one, after the last render.
  useEffect(() => onBeforeClose('save', () => {
    flushQueue(pendingItemSave());
  }), [flushQueue, pendingItemSave]);

  const handleSelectQueueItem = async (itemId: string): Promise<void> => {
    const item = queue.find(q => q.id === itemId);
    if (!item) return;

    // A completed item is shown with its output, to look at rather than edit.
    if (item.status === 'completed') {
      if (loadCompletedVideo && setCompletedVideoPath) {
        try {
          openItem(item.id, item.workflow, false);
          await loadVideoInfo(item.videoPath);
          setCompletedVideoPath(item.outputPath);
          await loadCompletedVideo(item.outputPath);
          onLog(`Loaded completed queue item: ${item.videoName}`);
        } catch (error) {
          onLog(`Error loading completed item: ${getErrorMessage(error)}`);
        }
      }
      return;
    }

    if (item.status !== 'pending') return;

    openItem(item.id, item.workflow, true);
    try {
      await loadVideoInfo(item.videoPath);
      onLog(`Loaded queue item for editing: ${item.videoName}`);
    } catch (error) {
      onLog(`Error loading queue item: ${getErrorMessage(error)}`);
    }
  };

  const handleStartQueue = (): void => {
    setIsQueueStarted(true);
    onLog('=== Starting queue processing ===');
  };

  const handleStopQueue = async (): Promise<void> => {
    setIsQueueStopping(true);
    onLog('Stopping queue processing...');

    try {
      if (isProcessingQueueItem) {
        await handleCancelUpscale();
      }
    } catch (error) {
      onLog(`Error stopping queue: ${getErrorMessage(error)}`);
    } finally {
      setIsQueueStarted(false);
      setIsProcessingQueue(false);
      setIsProcessingQueueItem(false);

      const processingItem = queue.find(item => item.status === 'processing');
      if (processingItem) {
        updateQueueItem(processingItem.id, { status: 'pending', progress: 0 });
      }

      setIsQueueStopping(false);
      onLog('Queue stopped');
    }
  };

  const handleCancelQueueItem = async (itemId: string): Promise<void> => {
    const item = queue.find(q => q.id === itemId);
    if (!item || item.status !== 'processing') return;

    onLog(`Canceling queue item: ${item.videoName}`);
    await handleCancelUpscale();

    updateQueueItem(itemId, {
      status: 'error',
      errorMessage: 'Canceled by user',
    });
  };

  const handleRequeueItem = (itemId: string): void => {
    requeueItem(itemId);
  };

  const handleCompareQueueItem = async (itemId: string): Promise<void> => {
    const item = queue.find(q => q.id === itemId);
    if (!item || item.status !== 'completed') return;

    try {
      onLog(`Launching comparison for queue item: ${item.videoName}`);
      const result = await window.electronAPI.compareVideos(item.videoPath, item.outputPath);
      if (!result.success) {
        onLog(`Error: ${result.error}`);
      }
    } catch (error) {
      onLog(`Error launching comparison: ${getErrorMessage(error)}`);
    }
  };

  const handleOpenQueueItemFolder = async (itemId: string): Promise<void> => {
    const item = queue.find(q => q.id === itemId);
    if (!item || item.status !== 'completed') return;

    try {
      onLog(`Opening folder for queue item: ${item.outputPath}`);
      await window.electronAPI.openOutputFolder(item.outputPath);
    } catch (error) {
      onLog(`Error opening folder: ${getErrorMessage(error)}`);
    }
  };

  return {
    handleSelectQueueItem,
    handleStartQueue,
    handleStopQueue,
    handleCancelQueueItem,
    handleRequeueItem,
    handleCompareQueueItem,
    handleOpenQueueItemFolder,
  };
}
