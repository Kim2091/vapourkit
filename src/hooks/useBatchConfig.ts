// src/hooks/useBatchConfig.ts - Adding videos: one loads into the window, several go to the queue

import type { QueueItem } from '../electron.d';
import { getErrorMessage } from '../types/errors';

interface UseBatchConfigOptions {
  /** The window's settings, as a queue item's workflow. */
  getWorkflow: () => QueueItem['workflow'];
  showQueue: boolean;
  onAddToQueue: (videoPaths: string[], workflow: QueueItem['workflow'], output?: { path: string; custom: boolean }) => void;
  /** Load a video into the project. */
  onLoadVideoInfo: (path: string) => Promise<unknown>;
  onLog: (message: string) => void;
}

export function useBatchConfig(options: UseBatchConfigOptions) {
  const { getWorkflow, showQueue, onAddToQueue, onLoadVideoInfo, onLog } = options;

  const handleSelectVideoWithQueue = async (): Promise<void> => {
    try {
      const files = await window.electronAPI.selectVideoFile();

      if (!files || files.length === 0) return;

      await handleBatchFiles(files);
    } catch (error) {
      onLog(`Error selecting videos: ${getErrorMessage(error)}`);
    }
  };

  const handleBatchFiles = async (files: string[]): Promise<void> => {
    // Single file - load it normally if queue is not shown, otherwise add to queue
    if (files.length === 1 && !showQueue) {
      await onLoadVideoInfo(files[0]);
      onLog(`Loaded video: ${files[0]}`);
      return;
    }

    // Single file with queue shown, or multiple files - add directly to queue
    onAddToQueue(files, getWorkflow());
  };

  /** Queue the window's video with the output path it shows, which custom says the user chose. */
  const handleAddCurrentVideoToQueue = (videoPath: string, output: { path: string; custom: boolean }): void => {
    onAddToQueue([videoPath], getWorkflow(), output);
    onLog(`Added current video to queue`);
  };

  return {
    handleSelectVideoWithQueue,
    handleBatchFiles,
    handleAddCurrentVideoToQueue,
  };
}
