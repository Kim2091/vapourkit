// src/hooks/useQueueEditing.ts - Queue item editing effects

import { useEffect } from 'react';
import type { SegmentSelection } from '../electron.d';

interface UseQueueEditingOptions {
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
  setEditingQueueItemId: (id: string | null) => void;
  updateItemWorkflow: (id: string, workflow: any) => void;
  onLog: (message: string) => void;
}

export function useQueueEditing(options: UseQueueEditingOptions) {
  const {
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
    setEditingQueueItemId,
    updateItemWorkflow,
    onLog,
  } = options;

  // Auto-save workflow changes when editing a queue item
  useEffect(() => {
    if (!editingQueueItemId) return;
    
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
    
    // Debounce auto-save to avoid excessive updates
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
}
