// src/hooks/useBatchConfig.ts - Batch configuration management

import { useState } from 'react';
import type { BatchVideoConfig } from '../components/BatchConfigModal';
import { getErrorMessage } from '../types/errors';

interface UseBatchConfigOptions {
  outputFormat: string;
  selectedModel: string | null;
  filters: any[];
  useDirectML: boolean;
  numStreams: number;
  onAddToQueue: (videoPaths: string[], workflow: any, outputPath?: string) => void;
  onLoadVideoInfo: (path: string) => Promise<void>;
  onLog: (message: string) => void;
}

export function useBatchConfig(options: UseBatchConfigOptions) {
  const { outputFormat, selectedModel, filters, useDirectML, numStreams, onAddToQueue, onLoadVideoInfo, onLog } = options;
  
  const [showBatchConfig, setShowBatchConfig] = useState(false);
  const [pendingBatchVideos, setPendingBatchVideos] = useState<BatchVideoConfig[]>([]);

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
      // Single file - load it normally
      if (files.length === 1) {
        await onLoadVideoInfo(files[0]);
        onLog(`Loaded video: ${files[0]}`);
        return;
      }
      
      // Multiple files - add to queue
      const currentWorkflowSnapshot = {
        selectedModel,
        filters: JSON.parse(JSON.stringify(filters)), // Deep copy
        outputFormat,
        useDirectML,
        numStreams,
      };
      
      const configs: BatchVideoConfig[] = files.map((videoPath: string) => {
        const videoName = videoPath.split(/[\\/]/).pop() || 'unknown';
        const outputPath = videoPath.replace(/\.[^.]+$/, `_upscaled.${outputFormat}`);
        
        return {
          videoPath,
          videoName,
          outputPath,
          workflow: JSON.parse(JSON.stringify(currentWorkflowSnapshot)) // Deep copy for each
        };
      });
      
      setPendingBatchVideos(configs);
      setShowBatchConfig(true);
      onLog(`Selected ${files.length} video(s) for queue`);
  };

  const handleConfirmBatchConfig = (configs: BatchVideoConfig[]): void => {
    try {
      // Add each configured video to the queue
      configs.forEach(config => {
        onAddToQueue([config.videoPath], config.workflow, config.outputPath);
      });
      
      onLog(`Added ${configs.length} video(s) to queue`);
      setShowBatchConfig(false);
      setPendingBatchVideos([]);
    } catch (error) {
      onLog(`Error adding to queue: ${getErrorMessage(error)}`);
    }
  };

  const handleCloseBatchConfig = (): void => {
    setShowBatchConfig(false);
    setPendingBatchVideos([]);
  };

  return {
    showBatchConfig,
    pendingBatchVideos,
    handleSelectVideoWithQueue,
    handleBatchFiles,
    handleConfirmBatchConfig,
    handleCloseBatchConfig,
  };
}
