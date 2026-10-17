// src/hooks/useQueueStore.ts - Consolidated queue data layer (merged from useQueueState + useQueueManagement)

import { useState, useEffect, useCallback, useRef } from 'react';
import type { QueueItem } from '../electron.d';
import { newQueueItems, uniqueOutputPath, withItemWorkflow, type OutputNaming, type QueueEntry } from '../utils/queueOutputPath';
import { normalizeBackendForCurrentPlatform } from '../utils/backends';
import { queueSaveDelay, queueShape } from '../utils/queueSaveTiming';
import { queueRunFlags, type QueueRunStatus } from '../utils/queueRun';

interface UseQueueStoreProps {
  onLog: (message: string) => void;
  /** How items are named when the user has not chosen an output path. */
  naming: OutputNaming;
}

export function useQueueStore({ onLog, naming }: UseQueueStoreProps) {
  const { defaultOutputFolder, descriptive } = naming;
  // --- UI state (from useQueueState) ---
  const [showQueue, setShowQueueRaw] = useState(false);
  const [isShowQueueLoaded, setIsShowQueueLoaded] = useState(false);
  const [runStatus, setRunStatus] = useState<QueueRunStatus>('idle');
  const [runningItemId, setRunningItemId] = useState<string | null>(null);

  // --- Queue data (from useQueueManagement) ---
  const [queue, setQueue] = useState<QueueEntry[]>([]);
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
      const resetQueue = (savedQueue as QueueEntry[]).map((item): QueueEntry => {
        const savedBackend = item.workflow.defaultBackend ?? item.workflow.useDirectML;
        const normalizedBackend = normalizeBackendForCurrentPlatform(savedBackend);
        const migrated: QueueEntry = item.workflow.defaultBackend === normalizedBackend && item.workflow.useDirectML === undefined
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

      const resetCount = resetQueue.filter((item, idx) =>
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
  const queueForSaveRef = useRef<QueueEntry[]>([]);
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
    workflow: QueueItem['workflow'],
    output?: { path: string; custom: boolean },
  ) => {
    setQueue(prevQueue => {
      const { items, skipped } = newQueueItems(prevQueue, videoPaths, workflow, { defaultOutputFolder, descriptive }, output);
      if (skipped > 0) {
        onLog(`Skipped ${skipped} video(s) already in queue`);
      }
      if (items.length === 0) return prevQueue;
      onLog(`Added ${items.length} video(s) to queue`);
      return [...prevQueue, ...items];
    });
  }, [onLog, defaultOutputFolder, descriptive]);

  const removeFromQueue = useCallback((itemId: string) => {
    setQueue(prev => {
      const updated = prev.filter(item => item.id !== itemId);
      onLog(`Removed item from queue`);
      return updated;
    });
  }, [onLog]);

  const updateQueueItem = useCallback((itemId: string, updates: Partial<QueueEntry>) => {
    setQueue(prev => prev.map(item =>
      item.id === itemId ? { ...item, ...updates } : item
    ));
  }, []);

  const updateItemWorkflow = useCallback((
    itemId: string,
    workflow: Partial<QueueItem['workflow']>
  ) => {
    setQueue(prev => withItemWorkflow(prev, itemId, workflow, { defaultOutputFolder, descriptive }));
  }, [defaultOutputFolder, descriptive]);

  /**
   * Write the queue now, synchronously, with the edited item's latest
   * settings folded in (an edit committed as the window closes has not
   * reached the queue's state yet): for when the window closes, which would
   * otherwise drop whatever the debounced saves had not written yet.
   */
  const latestQueueRef = useRef<QueueEntry[]>(queue);
  latestQueueRef.current = queue;
  const flushQueue = useCallback((pending?: { itemId: string; workflow: Partial<QueueItem['workflow']> }) => {
    if (!hasLoadedInitially.current) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = null;
    pendingSinceRef.current = null;
    const toSave = pending
      ? withItemWorkflow(latestQueueRef.current, pending.itemId, pending.workflow, { defaultOutputFolder, descriptive })
      : latestQueueRef.current;
    window.electronAPI.saveQueueSync(toSave);
  }, [defaultOutputFolder, descriptive]);

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
      const duplicate: QueueEntry = {
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
    runStatus,
    runningItemId,
    ...queueRunFlags(runStatus),
    setShowQueue,
    setRunStatus,
    setRunningItemId,

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
    requeueItem,
    duplicateQueueItem,
  };
}
