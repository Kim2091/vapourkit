// src/hooks/useQueueHandlers.ts - Queue operation handlers

import type { QueueItem, SegmentSelection } from '../electron.d';
import { getErrorMessage } from '../types/errors';

interface UseQueueHandlersOptions {
  queue: QueueItem[];
  editingQueueItemId: string | null;
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

export function useQueueHandlers(options: UseQueueHandlersOptions) {
  const {
    queue,
    editingQueueItemId,
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

  const handleSelectQueueItem = async (itemId: string): Promise<void> => {
    const item = queue.find(q => q.id === itemId);
    if (!item) return;

    // Handle completed item selection
    if (item.status === 'completed') {
      if (loadCompletedVideo && setCompletedVideoPath) {
        try {
          // Load video info first (resets state)
          await loadVideoInfo(item.videoPath);
          setOutputPath(item.outputPath);
          
          // Set completed state
          setCompletedVideoPath(item.outputPath);
          await loadCompletedVideo(item.outputPath);
          
          // Load the workflow settings so the UI reflects what was used
          setSelectedModel(item.workflow.selectedModel || '');
          setFilters(item.workflow.filters);
          setOutputFormat(item.workflow.outputFormat);
          toggleDirectML(item.workflow.useDirectML);
          updateNumStreams(item.workflow.numStreams);
          
          // Restore segment selection AFTER loading video info
          if (item.workflow.segment?.enabled) {
            setSegment(item.workflow.segment);
          } else {
            setSegment({ enabled: false, startFrame: 0, endFrame: -1 });
          }
          
          // Clear editing state if we were editing something
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
      const currentWorkflowSnapshot = {
        selectedModel,
        filters: structuredClone(filters),
        ffmpegArgs,
        processingFormat,
        outputFormat,
        videoCompareArgs,
        useDirectML,
        numStreams,
        segment: segment.enabled ? { ...segment } : undefined,
        colorimetry,
      };
      updateItemWorkflow(editingQueueItemId, currentWorkflowSnapshot);
      onLog(`Auto-saved changes to queue item`);
    }
    
    // Load the selected queue item's workflow into main window
    setEditingQueueItemId(itemId);
    setSelectedModel(item.workflow.selectedModel || '');
    setFilters(item.workflow.filters);
    setOutputFormat(item.workflow.outputFormat);
    toggleDirectML(item.workflow.useDirectML);
    updateNumStreams(item.workflow.numStreams);
    
    // Load video info and output path
    try {
      await loadVideoInfo(item.videoPath);
      setOutputPath(item.outputPath);
      
      // Restore segment selection AFTER loading video info
      // This ensures the segment isn't reset by the videoInfo change effect
      if (item.workflow.segment?.enabled) {
        setSegment(item.workflow.segment);
      } else {
        // Reset segment to disabled if the queue item doesn't have segment data
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
      // Cancel current processing if any
      if (isProcessingQueueItem) {
        await handleCancelUpscale();
      }
    } catch (error) {
      onLog(`Error stopping queue: ${getErrorMessage(error)}`);
    } finally {
      setIsQueueStarted(false);
      setIsProcessingQueue(false);
      setIsProcessingQueueItem(false);
      
      // Reset any processing items back to pending
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
    
    // Cancel the current upscale
    await handleCancelUpscale();
    
    // Mark item as error/canceled
    updateQueueItem(itemId, {
      status: 'error',
      errorMessage: 'Canceled by user',
    });
    
    // Do NOT clear the processing flag here.
    // The useQueueProcessing hook will handle it when the startUpscale promise rejects/returns.
    // Clearing it here causes a race condition where the next item starts before the current one finishes cleaning up.
    // setIsProcessingQueueItem(false);
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
