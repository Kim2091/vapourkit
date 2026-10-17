// src/hooks/useQueueOperations.ts - Queue user operations (merged from useQueueHandlers + useQueueEditing)

import { useEffect, useRef } from 'react';
import type { BackendId, QueueItem, SegmentSelection } from '../electron.d';
import { getErrorMessage } from '../types/errors';
import { normalizeBackendForCurrentPlatform } from '../utils/backends';
import { onBeforeClose } from '../utils/beforeClose';

/** Reads a queue item's backend, migrating the legacy useDirectML field on the fly. */
function workflowBackend(workflow: QueueItem['workflow']): BackendId {
  return normalizeBackendForCurrentPlatform(workflow.defaultBackend ?? workflow.useDirectML);
}

interface UseQueueOperationsOptions {
  queue: QueueItem[];
  editingQueueItemId: string | null;
  showQueue: boolean;
  selectedModel: string | null;
  filters: any[];
  /** The chain including changes not rendered yet (a code edit committed as the window closes). */
  getLatestFilters: () => any[];
  ffmpegArgs: string;
  processingFormat: string;
  outputFormat: string;
  videoCompareArgs: string;
  defaultBackend: BackendId;
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
  /** Swaps in a queue item's chain: saved, and a fresh start for undo. */
  setFilters: (filters: any[]) => void;
  setOutputFormat: (format: string) => void;
  setFfmpegArgs: (args: string) => void;
  setProcessingFormat: (format: string) => void;
  setVideoCompareArgs: (args: string) => void;
  setColorimetry: (colorimetry: any) => void;
  setDefaultBackend: (backend: BackendId) => void;
  updateNumStreams: (streams: number) => void;
  setSegment: (segment: SegmentSelection) => void;
  updateQueueItem: (id: string, updates: Partial<QueueItem>) => void;
  updateItemWorkflow: (id: string, workflow: any) => void;
  flushQueue: (pending?: { itemId: string; workflow: any }) => void;
  requeueItem: (id: string) => void;
  loadVideoInfo: (path: string) => Promise<unknown>;
  /** The output path the user chose for the window's video. */
  setOutputPathOverride: (path: string | null) => void;
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
  defaultBackend: BackendId;
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
    defaultBackend: options.defaultBackend,
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
    getLatestFilters,
    ffmpegArgs,
    processingFormat,
    outputFormat,
    videoCompareArgs,
    defaultBackend,
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
    setFfmpegArgs,
    setProcessingFormat,
    setVideoCompareArgs,
    setColorimetry,
    setDefaultBackend,
    updateNumStreams,
    setSegment,
    updateQueueItem,
    updateItemWorkflow,
    flushQueue,
    requeueItem,
    loadVideoInfo,
    setOutputPathOverride,
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
      outputFormat, videoCompareArgs, defaultBackend, numStreams,
      segment, colorimetry,
    });

    const timeoutId = setTimeout(() => {
      updateItemWorkflow(editingQueueItemId, currentWorkflowSnapshot);
    }, 500);

    return () => clearTimeout(timeoutId);
  }, [editingQueueItemId, selectedModel, filters, ffmpegArgs, processingFormat, outputFormat, videoCompareArgs, defaultBackend, numStreams, segment, colorimetry, updateItemWorkflow]);

  // The auto-save above waits half a second and the queue's own save two;
  // closing the window inside either dropped the edit. Write it all now.
  const snapshotNow = () => snapshotWorkflow({
    selectedModel, filters, ffmpegArgs, processingFormat,
    outputFormat, videoCompareArgs, defaultBackend, numStreams,
    segment, colorimetry,
  });
  const latestRef = useRef({ editingQueueItemId, snapshotNow });
  latestRef.current = { editingQueueItemId, snapshotNow };
  useEffect(() => onBeforeClose('save', () => {
    const { editingQueueItemId: editing, snapshotNow: snapshot } = latestRef.current;
    // The chain from getLatestFilters: a step's code still being typed is
    // committed in the phase before this one, after the last render.
    flushQueue(editing ? { itemId: editing, workflow: { ...snapshot(), filters: structuredClone(getLatestFilters()) } } : undefined);
  }), [flushQueue, getLatestFilters]);

  // Close editing mode when queue panel closes
  useEffect(() => {
    if (!showQueue && editingQueueItemId) {
      setEditingQueueItemId(null);
      onLog('Exited queue item editing mode');
    }
  }, [showQueue, editingQueueItemId, setEditingQueueItemId, onLog]);

  // --- Handlers (from useQueueHandlers) ---

  /** Put every setting a queue item carries into the main window, so what is shown is what is saved back. */
  const loadItemSettings = (workflow: QueueItem['workflow']) => {
    setSelectedModel(workflow.selectedModel || '');
    setFilters(workflow.filters);
    setOutputFormat(workflow.outputFormat);
    setDefaultBackend(workflowBackend(workflow));
    updateNumStreams(workflow.numStreams);
    // Older items may not carry these; they keep the current values then.
    if (typeof workflow.ffmpegArgs === 'string') setFfmpegArgs(workflow.ffmpegArgs);
    if (typeof workflow.processingFormat === 'string') setProcessingFormat(workflow.processingFormat);
    if (typeof workflow.videoCompareArgs === 'string') setVideoCompareArgs(workflow.videoCompareArgs);
    if (workflow.colorimetry) setColorimetry(workflow.colorimetry);
  };

  /** Save the item being edited before the window shows something else. */
  const saveEditedItem = () => {
    if (!editingQueueItemId) return;
    updateItemWorkflow(editingQueueItemId, snapshotNow());
    onLog(`Auto-saved changes to queue item`);
  };

  const handleSelectQueueItem = async (itemId: string): Promise<void> => {
    const item = queue.find(q => q.id === itemId);
    if (!item) return;

    // Handle completed item selection
    if (item.status === 'completed') {
      if (loadCompletedVideo && setCompletedVideoPath) {
        try {
          // Leaving the item being edited: its last edit may still be
          // waiting on the auto-save, which closing editing would cancel.
          saveEditedItem();
          await loadVideoInfo(item.videoPath);
          setOutputPathOverride(item.outputPath);
          setCompletedVideoPath(item.outputPath);
          await loadCompletedVideo(item.outputPath);

          loadItemSettings(item.workflow);

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
    saveEditedItem();

    // Load the selected queue item's workflow into main window
    setEditingQueueItemId(itemId);
    loadItemSettings(item.workflow);

    try {
      await loadVideoInfo(item.videoPath);

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
    // The item being edited may be the first to run; give it its last edit.
    saveEditedItem();
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
    saveEditedItem,
    handleSelectQueueItem,
    handleStartQueue,
    handleStopQueue,
    handleCancelQueueItem,
    handleRequeueItem,
    handleCompareQueueItem,
    handleOpenQueueItemFolder,
  };
}
