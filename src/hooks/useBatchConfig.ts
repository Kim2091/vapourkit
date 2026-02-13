// src/hooks/useBatchConfig.ts - Batch configuration management

import type { SegmentSelection } from '../electron.d';
import { getErrorMessage } from '../types/errors';

interface UseBatchConfigOptions {
  ffmpegArgs: string;
  processingFormat: string;
  outputFormat: string;
  videoCompareArgs: string;
  selectedModel: string | null;
  filters: any[];
  useDirectML: boolean;
  numStreams: number;
  segment?: SegmentSelection;
  colorimetry?: any;
  showQueue: boolean;
  onAddToQueue: (videoPaths: string[], workflow: any, outputPath?: string) => void;
  onLoadVideoInfo: (path: string) => Promise<void>;
  onLog: (message: string) => void;
}

export function useBatchConfig(options: UseBatchConfigOptions) {
  const { ffmpegArgs, processingFormat, outputFormat, videoCompareArgs, selectedModel, filters, useDirectML, numStreams, segment, colorimetry, showQueue, onAddToQueue, onLoadVideoInfo, onLog } = options;

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
        useDirectML,
        numStreams,
        segment: segment?.enabled ? { ...segment } : undefined,
        colorimetry,
      };

      // Respect the default output folder setting
      let defaultOutputFolder: string | null = null;
      try {
        const result = await window.electronAPI.getDefaultOutputFolder();
        defaultOutputFolder = result.folder;
      } catch { /* ignore */ }
      
      // Add each video directly to the queue without showing the modal
      files.forEach((videoPath: string) => {
        let outputPath: string;
        const fileName = videoPath.split(/[\\/]/).pop()?.replace(/\.[^/.]+$/, '') || 'output';
        if (defaultOutputFolder) {
          const separator = defaultOutputFolder.includes('\\') ? '\\' : '/';
          outputPath = `${defaultOutputFolder}${separator}${fileName}_processed.${outputFormat}`;
        } else {
          outputPath = videoPath.replace(/\.[^.]+$/, `_processed.${outputFormat}`);
        }
        onAddToQueue([videoPath], currentWorkflowSnapshot, outputPath);
      });
      
      onLog(`Added ${files.length} video(s) to queue`);
  };

  const handleAddCurrentVideoToQueue = (videoPath: string, outputPath: string): void => {
    const currentWorkflowSnapshot = {
      selectedModel,
      filters: structuredClone(filters), // Deep copy
      ffmpegArgs,
      processingFormat,
      outputFormat,
      videoCompareArgs,
      useDirectML,
      numStreams,
      segment: segment?.enabled ? { ...segment } : undefined,
      colorimetry,
    };
    
    onAddToQueue([videoPath], currentWorkflowSnapshot, outputPath);
    onLog(`Added current video to queue`);
  };

  return {
    handleSelectVideoWithQueue,
    handleBatchFiles,
    handleAddCurrentVideoToQueue,
  };
}
