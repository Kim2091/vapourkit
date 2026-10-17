// src/hooks/useBatchConfig.ts - Batch configuration management

import type { BackendId, SegmentSelection } from '../electron.d';
import { getErrorMessage } from '../types/errors';

interface UseBatchConfigOptions {
  ffmpegArgs: string;
  processingFormat: string;
  outputFormat: string;
  videoCompareArgs: string;
  selectedModel: string | null;
  filters: any[];
  defaultBackend: BackendId;
  numStreams: number;
  segment?: SegmentSelection;
  colorimetry?: any;
  showQueue: boolean;
  onAddToQueue: (videoPaths: string[], workflow: any, output?: { path: string; custom: boolean }) => void;
  onLoadVideoInfo: (path: string) => Promise<unknown>;
  onLog: (message: string) => void;
}

export function useBatchConfig(options: UseBatchConfigOptions) {
  const { ffmpegArgs, processingFormat, outputFormat, videoCompareArgs, selectedModel, filters, defaultBackend, numStreams, segment, colorimetry, showQueue, onAddToQueue, onLoadVideoInfo, onLog } = options;

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
      const currentWorkflowSnapshot = {
        selectedModel,
        filters: structuredClone(filters), // Deep copy
        ffmpegArgs,
        processingFormat,
        outputFormat,
        videoCompareArgs,
        defaultBackend,
        numStreams,
        segment: segment?.enabled ? { ...segment } : undefined,
        colorimetry,
      };

      onAddToQueue(files, currentWorkflowSnapshot);
  };

  /** Queue the window's video with the output path it shows, which custom says the user chose. */
  const handleAddCurrentVideoToQueue = (videoPath: string, output: { path: string; custom: boolean }): void => {
    const currentWorkflowSnapshot = {
      selectedModel,
      filters: structuredClone(filters), // Deep copy
      ffmpegArgs,
      processingFormat,
      outputFormat,
      videoCompareArgs,
      defaultBackend,
      numStreams,
      segment: segment?.enabled ? { ...segment } : undefined,
      colorimetry,
    };

    onAddToQueue([videoPath], currentWorkflowSnapshot, output);
    onLog(`Added current video to queue`);
  };

  return {
    handleSelectVideoWithQueue,
    handleBatchFiles,
    handleAddCurrentVideoToQueue,
  };
}
