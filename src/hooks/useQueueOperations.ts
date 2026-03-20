// src/hooks/useQueueOperations.ts - Queue user operations (merged from useQueueHandlers + useQueueEditing)

import { useEffect } from 'react';
import type { QueueItem, SegmentSelection } from '../electron.d';
import { getErrorMessage } from '../types/errors';

interface UseQueueOperationsOptions {
  queue: QueueItem[];
  editingQueueItemId: string | null;
  showQueue: boolean;
  selectedModel: string | null;
  filters: any[];
  ffmpegArgs: string;
  processingFormat: string;
  outputFormat: string;
  videoCompareArgs: string;
  useDirectML: boolean;
  numStreams: number;
  segment: SegmentSelection;
  colorimetry: any;
  isProcessingQueueItem: boolean;
  setEditingQueueItemId: (id: string | null) => void;
  setIsQueueStarted: (started: boolean) => void;
  setIsProcessingQueue: (processing: boolean) => void;
  setIsProcessingQueueItem: (processing: boolean) => void;
  setIsQueueStopping: (stopping: boolean) => void;
  setSelectedModel: (model: string) => void;
  setFilters: (filters: any[]) => void;
  setOutputFormat: (format: string) => void;
  toggleDirectML: (value: boolean) => void;
  updateNumStreams: (streams: number) => void;
  setSegment: (segment: SegmentSelection) => void;
  updateQueueItem: (id: string, updates: Partial<QueueItem>) => void;
  updateItemWorkflow: (id: string, workflow: any) => void;
  requeueItem: (id: string) => void;
  loadVideoInfo: (path: string) => Promise<void>;
  setOutputPath: (path: string) => void;
  handleCancelUpscale: () => Promise<void>;
  onLog: (message: string) => void;
  loadCompletedVideo?: (path: string) => Promise<void>;
  setCompletedVideoPath?: (path: string | null) => void;
}

/** Snapshot the current workflow state into a plain object for saving */
function snapshotWorkflow(options: {
  selectedModel: string | null;
  filters: any[];
  ffmpegArgs: string;
  processingFormat: string;
  outputFormat: string;
  videoCompareArgs: string;
  useDirectML: boolean;
  numStreams: number;
  segment: SegmentSelection;
  colorimetry: any;
}) {
  return {
    selectedModel: options.selectedModel,
    filters: structuredClone(options.filters),
    ffmpegArgs: options.ffmpegArgs,
    processingFormat: options.processingFormat,
    outputFormat: options.outputFormat,
    videoCompareArgs: options.videoCompareArgs,
    useDirectML: options.useDirectML,
    numStreams: options.numStreams,
    segment: options.segment.enabled ? { ...options.segment } : undefined,
    colorimetry: options.colorimetry,
  };
}

export function useQueueOperations(options: UseQueueOperationsOptions) {
  const {
    queue,
    editingQueueItemId,
    showQueue,
    selectedModel,
    filters,
    ffmpegArgs,
    processingFormat,
    outputFormat,
    videoCompareArgs,
    useDirectML,
    numStreams,
    segment,
    colorimetry,
    isProcessingQueueItem,
    setEditingQueueItemId,
    setIsQueueStarted,
    setIsProcessingQueue,
    setIsProcessingQueueItem,
    setIsQueueStopping,
    setSelectedModel,
    setFilters,
    setOutputFormat,
    toggleDirectML,
    updateNumStreams,
    setSegment,
    updateQueueItem,
    updateItemWorkflow,
    requeueItem,
    loadVideoInfo,
    setOutputPath,
    handleCancelUpscale,
    onLog,
    loadCompletedVideo,
    setCompletedVideoPath,
  } = options;

  // --- Auto-save effect (from useQueueEditing) ---
  useEffect(() => {
    if (!editingQueueItemId) return;

    const currentWorkflowSnapshot = snapshotWorkflow({
      selectedModel, filters, ffmpegArgs, processingFormat,
      outputFormat, videoCompareArgs, useDirectML, numStreams,
      segment, colorimetry,
    });

    const timeoutId = setTimeout(() => {
      updateItemWorkflow(editingQueueItemId, currentWorkflowSnapshot);
    }, 500);

    return () => clearTimeout(timeoutId);
  }, [editingQueueItemId, selectedModel, filters, ffmpegArgs, processingFormat, outputFormat, videoCompareArgs, useDirectML, numStreams, segment, colorimetry, updateItemWorkflow]);

  // Close editing mode when queue panel closes
  useEffect(() => {
    if (!showQueue && editingQueueItemId) {
      setEditingQueueItemId(null);
      onLog('Exited queue item editing mode');
    }
  }, [showQueue, editingQueueItemId, setEditingQueueItemId, onLog]);

  // --- Handlers (from useQueueHandlers) ---

  const handleSelectQueueItem = async (itemId: string): Promise<void> => {
    const item = queue.find(q => q.id === itemId);
    if (!item) return;

    // Handle completed item selection
    if (item.status === 'completed') {
      if (loadCompletedVideo && setCompletedVideoPath) {
        try {
          await loadVideoInfo(item.videoPath);
          setOutputPath(item.outputPath);
          setCompletedVideoPath(item.outputPath);
          await loadCompletedVideo(item.outputPath);

          setSelectedModel(item.workflow.selectedModel || '');
          setFilters(item.workflow.filters);
          setOutputFormat(item.workflow.outputFormat);
          toggleDirectML(item.workflow.useDirectML);
          updateNumStreams(item.workflow.numStreams);

          if (item.workflow.segment?.enabled) {
            setSegment(item.workflow.segment);
          } else {
            setSegment({ enabled: false, startFrame: 0, endFrame: -1 });
          }

          setEditingQueueItemId(null);
          onLog(`Loaded completed queue item: ${item.videoName}`);
        } catch (error) {
          onLog(`Error loading completed item: ${getErrorMessage(error)}`);
        }
      }
      return;
    }

    if (item.status !== 'pending') return;

    // Auto-save current workflow to the currently editing queue item if any
    if (editingQueueItemId) {
      updateItemWorkflow(editingQueueItemId, snapshotWorkflow({
        selectedModel, filters, ffmpegArgs, processingFormat,
        outputFormat, videoCompareArgs, useDirectML, numStreams,
        segment, colorimetry,
      }));
      onLog(`Auto-saved changes to queue item`);
    }

    // Load the selected queue item's workflow into main window
    setEditingQueueItemId(itemId);
    setSelectedModel(item.workflow.selectedModel || '');
    setFilters(item.workflow.filters);
    setOutputFormat(item.workflow.outputFormat);
    toggleDirectML(item.workflow.useDirectML);
    updateNumStreams(item.workflow.numStreams);

    try {
      await loadVideoInfo(item.videoPath);
      setOutputPath(item.outputPath);

      if (item.workflow.segment?.enabled) {
        setSegment(item.workflow.segment);
      } else {
        setSegment({ enabled: false, startFrame: 0, endFrame: -1 });
      }

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
