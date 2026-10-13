import { useState, useEffect, useCallback, useRef } from 'react';
import type { Filter } from '../electron.d';
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
    resetHistory,
  } = useFilterHistory(initialFilters);

  const [filters, setFiltersState] = useState<Filter[]>(historyFilters);

  // The chain as of the last change, ahead of the render that shows it: for
  // work that finishes later (an Align, a generated LUT) and has to apply its
  // result to the chain as it is then, not as it was when it started.
  const latestRef = useRef<Filter[]>(historyFilters);
  const setFilters = useCallback((value: Filter[]) => {
    latestRef.current = value;
    setFiltersState(value);
  }, []);

  // Which chain the window holds. Bumped whenever a different one is swapped
  // in (a queue item's, the project's back), so a result started on one chain
  // is not applied to another that happens to share step ids, as a queue item
  // copied from the project does.
  const [chainEpoch, setChainEpoch] = useState(0);
  const epochRef = useRef(0);

  // Sync filters with history state
  useEffect(() => {
    setFilters(historyFilters);
    localStorage.setItem('filters', JSON.stringify(historyFilters));
  }, [historyFilters, setFilters]);

  // There used to be a load from app-config's filterConfigurations here.
  // Nothing has written that since before 0.9.3, and the load re-ran on every
  // edit, so a list left in an old config would have replaced the chain each
  // time it changed. localStorage is the chain's only home.

  // Wrapper to persist state changes and record in history
  const handleSetFilters = useCallback((value: Filter[]) => {
    setFilters(value);
    localStorage.setItem('filters', JSON.stringify(value));
    recordState(value);
  }, [recordState, setFilters]);

  // Swap in a different chain (a queue item's, or the project's back again):
  // saved like any change, but a fresh start for undo.
  const replaceFilters = useCallback((value: Filter[]) => {
    setFilters(value);
    localStorage.setItem('filters', JSON.stringify(value));
    resetHistory(value);
    epochRef.current += 1;
    setChainEpoch(epochRef.current);
  }, [resetHistory, setFilters]);

  /**
   * Start work on one step that will change it later. The function returned
   * applies the change to that step as the chain is when the work finishes,
   * keeping every other edit made meanwhile, and does nothing (returning
   * false) if the step is gone or a different chain has been swapped in.
   */
  const beginStepPatch = useCallback((stepId: string) => {
    const startedOn = epochRef.current;
    return (patch: (step: Filter) => Filter): boolean => {
      if (epochRef.current !== startedOn) return false;
      const latest = latestRef.current;
      if (!latest.some(step => step.id === stepId)) return false;
      handleSetFilters(latest.map(step => step.id === stepId ? patch(step) : step));
      return true;
    };
  }, [handleSetFilters]);

  const getLatestFilters = useCallback(() => latestRef.current, []);

  // Undo handler
  const handleUndo = useCallback(() => {
    const previousState = undo();
    if (previousState) {
      setFilters(previousState);
      localStorage.setItem('filters', JSON.stringify(previousState));
      onLog('Undo filter change');
    }
  }, [undo, onLog, setFilters]);

  // Redo handler
  const handleRedo = useCallback(() => {
    const nextState = redo();
    if (nextState) {
      setFilters(nextState);
      localStorage.setItem('filters', JSON.stringify(nextState));
      onLog('Redo filter change');
    }
  }, [redo, onLog, setFilters]);

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
    replaceFilters,
    beginStepPatch,
    getLatestFilters,
    chainEpoch,
    canUndo,
    canRedo,
    handleUndo,
    handleRedo,
  };
}
