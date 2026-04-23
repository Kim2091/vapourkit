// src/hooks/useQueueStore.ts - Consolidated queue data layer (merged from useQueueState + useQueueManagement)

import { useState, useEffect, useCallback, useRef } from 'react';
import type { QueueItem, Filter, SegmentSelection } from '../electron.d';
import { generateOutputSuffix } from '../utils/generateOutputSuffix';

interface UseQueueStoreProps {
  onLog: (message: string) => void;
  descriptiveNamingEnabled?: boolean;
}

export function useQueueStore({ onLog, descriptiveNamingEnabled = true }: UseQueueStoreProps) {
  // --- UI state (from useQueueState) ---
  const [showQueue, setShowQueueRaw] = useState(false);
  const [editingQueueItemId, setEditingQueueItemId] = useState<string | null>(null);
  const [isProcessingQueue, setIsProcessingQueue] = useState(false);
  const [isQueueStarted, setIsQueueStarted] = useState(false);
  const [isQueueStopping, setIsQueueStopping] = useState(false);
  const [isProcessingQueueItem, setIsProcessingQueueItem] = useState(false);

  // --- Queue data (from useQueueManagement) ---
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [isLoadingQueue, setIsLoadingQueue] = useState(true);
  const hasLoadedInitially = useRef(false);

  // Load showQueue state from persistent storage
  useEffect(() => {
    const loadState = async () => {
      try {
        const result = await window.electronAPI.getShowQueue();
        setShowQueueRaw(result.show);
      } catch (error) {
        onLog(`Error loading queue state: ${error}`);
      }
    };
    loadState();
  }, [onLog]);

  const setShowQueue = useCallback((show: boolean) => {
    setShowQueueRaw(show);
    window.electronAPI.setShowQueue(show).catch(error => {
      onLog(`Error saving queue state: ${error}`);
    });
  }, [onLog]);

  // Load queue from persistent storage
  const loadQueue = useCallback(async () => {
    try {
      const savedQueue = await window.electronAPI.getQueue();

      // Reset any items that were processing when app was closed
      const resetQueue = savedQueue.map((item: QueueItem) => {
        if (item.status === 'processing') {
          return { ...item, status: 'pending' as const, progress: 0 };
        }
        return item;
      });

      const resetCount = resetQueue.filter((item: QueueItem, idx: number) =>
        item.status === 'pending' && savedQueue[idx].status === 'processing'
      ).length;

      if (resetCount > 0) {
        onLog(`Reset ${resetCount} interrupted item(s) back to pending`);
      }

      setQueue(resetQueue);
      onLog(`Loaded ${resetQueue.length} queue items`);
    } catch (error) {
      onLog(`Error loading queue: ${error}`);
      setQueue([]);
    } finally {
      setIsLoadingQueue(false);
      hasLoadedInitially.current = true;
    }
  }, [onLog]);

  // Save queue to persistent storage
  const saveQueue = useCallback(async (queueToSave: QueueItem[]) => {
    try {
      await window.electronAPI.saveQueue(queueToSave);
    } catch (error) {
      onLog(`Error saving queue: ${error}`);
    }
  }, [onLog]);

  // Load queue on mount
  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  // Auto-save queue whenever it changes (debounced)
  const queueForSaveRef = useRef<QueueItem[]>([]);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (hasLoadedInitially.current && !isLoadingQueue) {
      queueForSaveRef.current = queue;

      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }

      saveTimeoutRef.current = setTimeout(() => {
        saveQueue(queueForSaveRef.current);
      }, 2000);

      return () => {
        if (saveTimeoutRef.current) {
          clearTimeout(saveTimeoutRef.current);
        }
      };
    }
  }, [queue, isLoadingQueue, saveQueue]);

  // --- Queue CRUD operations ---

  const addToQueue = useCallback((
    videoPaths: string[],
    currentWorkflow: {
      selectedModel: string | null;
      filters: Filter[];
      ffmpegArgs: string;
      processingFormat: string;
      outputFormat: string;
      videoCompareArgs: string;
      useDirectML: boolean;
      numStreams: number;
      segment?: SegmentSelection;
      colorimetry?: any;
    },
    customOutputPath?: string
  ) => {
    setQueue(prevQueue => {
      const existingPaths = new Set(
        prevQueue
          .filter(item => item.status === 'pending' || item.status === 'processing')
          .map(item => item.videoPath.toLowerCase())
      );
      const uniquePaths = videoPaths.filter(vp => !existingPaths.has(vp.toLowerCase()));
      const skippedCount = videoPaths.length - uniquePaths.length;
      if (skippedCount > 0) {
        onLog(`Skipped ${skippedCount} video(s) already in queue`);
      }
      if (uniquePaths.length === 0) return prevQueue;

      const newItems: QueueItem[] = uniquePaths.map(videoPath => {
        const videoName = videoPath.split(/[\\\\]/).pop() || 'unknown';

        let outputPath: string;
        if (customOutputPath) {
          outputPath = customOutputPath;
        } else {
          const suffix = descriptiveNamingEnabled
            ? generateOutputSuffix(
                {
                  colorimetry: currentWorkflow.colorimetry,
                  filters: currentWorkflow.filters,
                  segment: currentWorkflow.segment,
                  selectedModel: currentWorkflow.selectedModel,
                }
              )
            : 'processed';
          outputPath = videoPath.replace(/\.[^/.]+$/, '') + `-${suffix}.${currentWorkflow.outputFormat}`;
        }

        return {
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          videoPath,
          videoName,
          outputPath,
          status: 'pending' as const,
          addedAt: new Date().toISOString(),
          workflow: {
            selectedModel: currentWorkflow.selectedModel,
            filters: structuredClone(currentWorkflow.filters),
            ffmpegArgs: currentWorkflow.ffmpegArgs,
            processingFormat: currentWorkflow.processingFormat,
            outputFormat: currentWorkflow.outputFormat,
            videoCompareArgs: currentWorkflow.videoCompareArgs,
            useDirectML: currentWorkflow.useDirectML,
            numStreams: currentWorkflow.numStreams,
            segment: currentWorkflow.segment ? { ...currentWorkflow.segment } : undefined,
            colorimetry: currentWorkflow.colorimetry,
          },
        };
      });

      onLog(`Added ${newItems.length} video(s) to queue`);
      return [...prevQueue, ...newItems];
    });
    return [];
  }, [onLog, descriptiveNamingEnabled]);

  const removeFromQueue = useCallback((itemId: string) => {
    setQueue(prev => {
      const updated = prev.filter(item => item.id !== itemId);
      onLog(`Removed item from queue`);
      return updated;
    });
  }, [onLog]);

  const updateQueueItem = useCallback((itemId: string, updates: Partial<QueueItem>) => {
    setQueue(prev => prev.map(item =>
      item.id === itemId ? { ...item, ...updates } : item
    ));
  }, []);

  const updateItemWorkflow = useCallback((
    itemId: string,
    workflow: Partial<QueueItem['workflow']>
  ) => {
    setQueue(prev => prev.map(item =>
      item.id === itemId
        ? { ...item, workflow: { ...item.workflow, ...workflow } }
        : item
    ));
    onLog(`Updated workflow for queue item`);
  }, [onLog]);

  const clearQueue = useCallback(async () => {
    try {
      await window.electronAPI.clearQueue();
      setQueue([]);
      onLog('Queue cleared');
    } catch (error) {
      onLog(`Error clearing queue: ${error}`);
    }
  }, [onLog]);

  const clearCompletedItems = useCallback(() => {
    setQueue(prev => {
      const updated = prev.filter(item =>
        item.status === 'pending' || item.status === 'processing'
      );
      onLog(`Cleared ${prev.length - updated.length} completed items`);
      return updated;
    });
  }, [onLog]);

  const reorderQueue = useCallback((fromIndex: number, toIndex: number) => {
    setQueue(prev => {
      const updated = [...prev];
      const [removed] = updated.splice(fromIndex, 1);
      updated.splice(toIndex, 0, removed);
      return updated;
    });
  }, []);

  const getNextPendingItem = useCallback((): QueueItem | null => {
    return queue.find(item => item.status === 'pending') || null;
  }, [queue]);

  const getQueueStats = useCallback(() => {
    return {
      total: queue.length,
      pending: queue.filter(item => item.status === 'pending').length,
      processing: queue.filter(item => item.status === 'processing').length,
      completed: queue.filter(item => item.status === 'completed').length,
      error: queue.filter(item => item.status === 'error').length,
    };
  }, [queue]);

  const requeueItem = useCallback((itemId: string) => {
    setQueue(prev => prev.map(item =>
      item.id === itemId && (item.status === 'completed' || item.status === 'error')
        ? { ...item, status: 'pending' as const, progress: 0, errorMessage: undefined }
        : item
    ));
    onLog('Item reset to pending for reprocessing');
  }, [onLog]);

  const duplicateQueueItem = useCallback((itemId: string) => {
    setQueue(prev => {
      const item = prev.find(q => q.id === itemId);
      if (!item) return prev;
      const duplicate: QueueItem = {
        ...item,
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        status: 'pending' as const,
        progress: 0,
        errorMessage: undefined,
        addedAt: new Date().toISOString(),
        completedAt: undefined,
        workflow: structuredClone(item.workflow),
      };
      const idx = prev.findIndex(q => q.id === itemId);
      const updated = [...prev];
      updated.splice(idx + 1, 0, duplicate);
      onLog(`Duplicated queue item: ${item.videoName}`);
      return updated;
    });
  }, [onLog]);

  return {
    // UI state
    showQueue,
    editingQueueItemId,
    isProcessingQueue,
    isQueueStarted,
    isQueueStopping,
    isProcessingQueueItem,
    setShowQueue,
    setEditingQueueItemId,
    setIsProcessingQueue,
    setIsQueueStarted,
    setIsQueueStopping,
    setIsProcessingQueueItem,

    // Queue data
    queue,
    isLoadingQueue,
    addToQueue,
    removeFromQueue,
    updateQueueItem,
    updateItemWorkflow,
    clearQueue,
    clearCompletedItems,
    reorderQueue,
    getNextPendingItem,
    getQueueStats,
    requeueItem,
    duplicateQueueItem,
  };
}
