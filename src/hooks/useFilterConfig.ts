import { useState, useEffect, useCallback } from 'react';
import type { Filter } from '../electron.d';
import { getErrorMessage } from '../types/errors';
import { useFilterHistory } from './useFilterHistory';
import { useUndoRedoShortcuts } from './useUndoRedoShortcuts';

export function useFilterConfig(
  isSetupComplete: boolean, 
  onLog: (message: string) => void
) {
  const [initialFilters] = useState<Filter[]>(() => {
    const saved = localStorage.getItem('filters');
    return saved !== null ? JSON.parse(saved) : [];
  });

  // Initialize filter history with the loaded filters
  const {
    filters: historyFilters,
    recordState,
    undo,
    redo,
    canUndo,
    canRedo,
    clearHistory,
  } = useFilterHistory(initialFilters);

  const [filters, setFilters] = useState<Filter[]>(historyFilters);

  // Sync filters with history state
  useEffect(() => {
    setFilters(historyFilters);
    localStorage.setItem('filters', JSON.stringify(historyFilters));
  }, [historyFilters]);

  // Load filter configurations from backend
  useEffect(() => {
    const loadFilterConfigurations = async () => {
      try {
        const savedFilters = await window.electronAPI.getFilterConfigurations();
        if (savedFilters && savedFilters.length > 0) {
          setFilters(savedFilters);
          localStorage.setItem('filters', JSON.stringify(savedFilters));
          clearHistory(); // Clear history when loading new filters
          onLog(`Loaded ${savedFilters.length} filter configuration(s)`);
        }
      } catch (error) {
        onLog(`Error loading filter configurations: ${getErrorMessage(error)}`);
      }
    };

    if (isSetupComplete) {
      loadFilterConfigurations();
    }
  }, [isSetupComplete, onLog, clearHistory]);

  // Wrapper to persist state changes and record in history
  const handleSetFilters = useCallback((value: Filter[]) => {
    setFilters(value);
    localStorage.setItem('filters', JSON.stringify(value));
    recordState(value);
  }, [recordState]);

  // Undo handler
  const handleUndo = useCallback(() => {
    const previousState = undo();
    if (previousState) {
      setFilters(previousState);
      localStorage.setItem('filters', JSON.stringify(previousState));
      onLog('Undo filter change');
    }
  }, [undo, onLog]);

  // Redo handler
  const handleRedo = useCallback(() => {
    const nextState = redo();
    if (nextState) {
      setFilters(nextState);
      localStorage.setItem('filters', JSON.stringify(nextState));
      onLog('Redo filter change');
    }
  }, [redo, onLog]);

  // Setup keyboard shortcuts for undo/redo
  useUndoRedoShortcuts({
    onUndo: handleUndo,
    onRedo: handleRedo,
    enabled: isSetupComplete,
  });

  return {
    filters,
    setFilters,
    handleSetFilters,
    canUndo,
    canRedo,
    handleUndo,
    handleRedo,
  };
}
