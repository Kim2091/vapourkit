// src/hooks/useQueueStore.ts - Consolidated queue data layer (merged from useQueueState + useQueueManagement)

import { useState, useEffect, useCallback, useRef } from 'react';
import type { BackendId, QueueItem, Filter, SegmentSelection } from '../electron.d';
import { autoOutputPath, uniqueOutputPath } from '../utils/queueOutputPath';
import { normalizeBackendForCurrentPlatform } from '../utils/backends';
import { queueSaveDelay, queueShape } from '../utils/queueSaveTiming';

const EDITING_ITEM_KEY = 'editingQueueItemId';

interface UseQueueStoreProps {
  onLog: (message: string) => void;
  descriptiveNamingEnabled?: boolean;
}

export function useQueueStore({ onLog, descriptiveNamingEnabled = true }: UseQueueStoreProps) {
  // --- UI state (from useQueueState) ---
  const [showQueue, setShowQueueRaw] = useState(false);
  const [isShowQueueLoaded, setIsShowQueueLoaded] = useState(false);
  const [editingQueueItemId, setEditingQueueItemIdRaw] = useState<string | null>(null);
  // The item being edited when the app last closed. Editing puts the item's
  // chain and encoding settings in the window, and those are saved, so after a
  // restart the window still shows them: App re-enters editing that item
  // rather than leave it on screen with nowhere for edits to go.
  const [resumeEditingId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(EDITING_ITEM_KEY);
    } catch {
      return null;
    }
  });
  const setEditingQueueItemId = useCallback((id: string | null) => {
    setEditingQueueItemIdRaw(id);
    try {
      if (id) localStorage.setItem(EDITING_ITEM_KEY, id);
      else localStorage.removeItem(EDITING_ITEM_KEY);
    } catch {
      // Storage blocked: editing still works for this session.
    }
  }, []);
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
      } finally {
        setIsShowQueueLoaded(true);
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

      // Reset any items that were processing when app was closed, and migrate
      // legacy workflows (useDirectML boolean) to backend ids
      const resetQueue = savedQueue.map((item: QueueItem) => {
        const savedBackend = item.workflow.defaultBackend ?? item.workflow.useDirectML;
        const normalizedBackend = normalizeBackendForCurrentPlatform(savedBackend);
        const migrated: QueueItem = item.workflow.defaultBackend === normalizedBackend && item.workflow.useDirectML === undefined
          ? item
          : {
              ...item,
              workflow: {
                ...item.workflow,
                defaultBackend: normalizedBackend,
                useDirectML: undefined,
              },
            };
        if (migrated.status === 'processing') {
          return { ...migrated, status: 'pending' as const, progress: 0 };
        }
        return migrated;
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

  // Auto-save queue whenever it changes: debounced, but never for longer than
  // a cap, and at once when items are added, removed, moved or change status
  // (utils/queueSaveTiming.ts says why).
  const queueForSaveRef = useRef<QueueItem[]>([]);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedShapeRef = useRef<string | null>(null);
  const pendingSinceRef = useRef<number | null>(null);
  // A change that must be saved at once stays urgent until it is, even if a
  // progress update reschedules the timer first.
  const urgentRef = useRef(false);

  useEffect(() => {
    if (!hasLoadedInitially.current || isLoadingQueue) return;
    queueForSaveRef.current = queue;

    const shape = queueShape(queue);
    if (savedShapeRef.current !== null && shape !== savedShapeRef.current) urgentRef.current = true;
    savedShapeRef.current = shape;
    const now = Date.now();
    if (pendingSinceRef.current === null) pendingSinceRef.current = now;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = setTimeout(() => {
      saveTimeoutRef.current = null;
      pendingSinceRef.current = null;
      urgentRef.current = false;
      saveQueue(queueForSaveRef.current);
    }, queueSaveDelay(urgentRef.current, pendingSinceRef.current, now));
  }, [queue, isLoadingQueue, saveQueue]);

  // Unmounting drops the timer; closing the window is covered by flushQueue.
  useEffect(() => () => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
  }, []);

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
      defaultBackend: BackendId;
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

        const outputPath = customOutputPath
          ?? autoOutputPath(videoPath, currentWorkflow, descriptiveNamingEnabled);

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
            defaultBackend: currentWorkflow.defaultBackend,
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

  /** prev with itemId's workflow updated (shared by edits and the save on close). */
  const withItemWorkflow = useCallback((
    prev: QueueItem[],
    itemId: string,
    workflow: Partial<QueueItem['workflow']>
  ) => prev.map(item => {
    if (item.id !== itemId) return item;
    // An item that has started (or finished) was encoded with the settings it
    // had then; an edit landing now would describe a render that never ran.
    if (item.status !== 'pending') return item;
    const merged = { ...item.workflow, ...workflow };
    // An auto-named output follows the edit, so a duplicated item that is
    // then given a different chain gets its own file instead of overwriting
    // the original's (#2). A path the user picked is left alone.
    let outputPath = item.outputPath;
    if (item.outputPath === autoOutputPath(item.videoPath, item.workflow, descriptiveNamingEnabled)) {
      outputPath = uniqueOutputPath(
        autoOutputPath(item.videoPath, merged, descriptiveNamingEnabled),
        prev.filter(other => other.id !== itemId).map(other => other.outputPath),
      );
    }
    return { ...item, outputPath, workflow: merged };
  }), [descriptiveNamingEnabled]);

  const updateItemWorkflow = useCallback((
    itemId: string,
    workflow: Partial<QueueItem['workflow']>
  ) => {
    setQueue(prev => withItemWorkflow(prev, itemId, workflow));
    onLog(`Updated workflow for queue item`);
  }, [onLog, withItemWorkflow]);

  /**
   * Write the queue now, synchronously, with an edit still waiting to be
   * auto-saved folded in: for when the window closes, which would otherwise
   * drop whatever the debounced saves had not written yet.
   */
  const latestQueueRef = useRef<QueueItem[]>(queue);
  latestQueueRef.current = queue;
  const flushQueue = useCallback((pending?: { itemId: string; workflow: Partial<QueueItem['workflow']> }) => {
    if (!hasLoadedInitially.current) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = null;
    pendingSinceRef.current = null;
    const toSave = pending
      ? withItemWorkflow(latestQueueRef.current, pending.itemId, pending.workflow)
      : latestQueueRef.current;
    window.electronAPI.saveQueueSync(toSave);
  }, [withItemWorkflow]);

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
        // Its own file: two items writing one path overwrite each other (#2).
        outputPath: uniqueOutputPath(item.outputPath, prev.map(q => q.outputPath)),
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
    isShowQueueLoaded,
    editingQueueItemId,
    resumeEditingId,
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
    flushQueue,
    clearQueue,
    clearCompletedItems,
    reorderQueue,
    getNextPendingItem,
    getQueueStats,
    requeueItem,
    duplicateQueueItem,
  };
}
