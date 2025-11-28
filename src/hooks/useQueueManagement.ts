import { useState, useEffect, useCallback, useRef } from 'react';
import type { QueueItem, Filter, SegmentSelection } from '../electron.d';

interface UseQueueManagementProps {
  onLog: (message: string) => void;
}

export function useQueueManagement({ onLog }: UseQueueManagementProps) {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [isLoadingQueue, setIsLoadingQueue] = useState(true);
  const hasLoadedInitially = useRef(false);

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

  // Auto-save queue whenever it changes (but only after initial load)
  // Debounce saves to prevent excessive disk writes during processing
  useEffect(() => {
    if (hasLoadedInitially.current && !isLoadingQueue) {
      const timeoutId = setTimeout(() => {
        saveQueue(queue);
      }, 2000); // Debounce by 2 seconds
      
      return () => clearTimeout(timeoutId);
    }
  }, [queue, isLoadingQueue, saveQueue]);

  // Add videos to queue
  const addToQueue = useCallback((
    videoPaths: string[],
    currentWorkflow: {
      selectedModel: string | null;
      filters: Filter[];
      outputFormat: string;
      useDirectML: boolean;
      numStreams: number;
      segment?: SegmentSelection;
    },
    customOutputPath?: string
  ) => {
    const newItems: QueueItem[] = videoPaths.map(videoPath => {
      const videoName = videoPath.split(/[\\\\]/).pop() || 'unknown';
      
      // Generate output path
      let outputPath: string;
      if (customOutputPath) {
        // If custom output path is provided, use it directly
        outputPath = customOutputPath;
      } else {
        // Use same directory as input video
        outputPath = videoPath.replace(/\.[^/.]+$/, '') + `_processed.${currentWorkflow.outputFormat}`;
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
          filters: JSON.parse(JSON.stringify(currentWorkflow.filters)), // Deep copy
          outputFormat: currentWorkflow.outputFormat,
          useDirectML: currentWorkflow.useDirectML,
          numStreams: currentWorkflow.numStreams,
          segment: currentWorkflow.segment ? { ...currentWorkflow.segment } : undefined,
        },
      };
    });

    setQueue(prev => [...prev, ...newItems]);
    onLog(`Added ${newItems.length} video(s) to queue`);
    return newItems;
  }, [onLog]);

  // Remove item from queue
  const removeFromQueue = useCallback((itemId: string) => {
    setQueue(prev => {
      const updated = prev.filter(item => item.id !== itemId);
      onLog(`Removed item from queue`);
      return updated;
    });
  }, [onLog]);

  // Update queue item
  const updateQueueItem = useCallback((itemId: string, updates: Partial<QueueItem>) => {
    setQueue(prev => prev.map(item => 
      item.id === itemId ? { ...item, ...updates } : item
    ));
  }, []);

  // Update item workflow
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

  // Clear entire queue
  const clearQueue = useCallback(async () => {
    try {
      await window.electronAPI.clearQueue();
      setQueue([]);
      onLog('Queue cleared');
    } catch (error) {
      onLog(`Error clearing queue: ${error}`);
    }
  }, [onLog]);

  // Clear only completed/error items
  const clearCompletedItems = useCallback(() => {
    setQueue(prev => {
      const updated = prev.filter(item => 
        item.status === 'pending' || item.status === 'processing'
      );
      onLog(`Cleared ${prev.length - updated.length} completed items`);
      return updated;
    });
  }, [onLog]);

  // Reorder queue items
  const reorderQueue = useCallback((fromIndex: number, toIndex: number) => {
    setQueue(prev => {
      const updated = [...prev];
      const [removed] = updated.splice(fromIndex, 1);
      updated.splice(toIndex, 0, removed);
      return updated;
    });
  }, []);

  // Get next pending item
  const getNextPendingItem = useCallback((): QueueItem | null => {
    return queue.find(item => item.status === 'pending') || null;
  }, [queue]);

  // Get queue statistics
  const getQueueStats = useCallback(() => {
    return {
      total: queue.length,
      pending: queue.filter(item => item.status === 'pending').length,
      processing: queue.filter(item => item.status === 'processing').length,
      completed: queue.filter(item => item.status === 'completed').length,
      error: queue.filter(item => item.status === 'error').length,
    };
  }, [queue]);

  // Requeue a completed or errored item
  const requeueItem = useCallback((itemId: string) => {
    setQueue(prev => prev.map(item => 
      item.id === itemId && (item.status === 'completed' || item.status === 'error')
        ? { ...item, status: 'pending' as const, progress: 0, errorMessage: undefined }
        : item
    ));
    onLog('Item reset to pending for reprocessing');
  }, [onLog]);

  return {
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
  };
}
