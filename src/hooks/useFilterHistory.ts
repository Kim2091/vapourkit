import { useState, useCallback, useRef, useEffect } from 'react';
import type { Filter } from '../electron.d';

interface HistoryState {
  past: Filter[][];
  present: Filter[];
  future: Filter[][];
}

const MAX_HISTORY_SIZE = 50;

/**
 * Hook to manage undo/redo history for filter configurations
 * Tracks filter state changes and provides undo/redo functionality
 */
export function useFilterHistory(initialFilters: Filter[]) {
  const [history, setHistory] = useState<HistoryState>({
    past: [],
    present: initialFilters,
    future: [],
  });

  // Track if we should record history (prevents recording during undo/redo operations)
  const shouldRecordRef = useRef(true);
  
  // Track the last recorded state to avoid duplicate entries
  const lastRecordedRef = useRef<string>(JSON.stringify(initialFilters));

  // Update present state when initialFilters change from outside (e.g., loading from storage)
  useEffect(() => {
    const newStateStr = JSON.stringify(initialFilters);
    // Only update if it's genuinely different and we're not in the middle of undo/redo
    if (shouldRecordRef.current && newStateStr !== JSON.stringify(history.present)) {
      setHistory({
        past: [],
        present: initialFilters,
        future: [],
      });
      lastRecordedRef.current = newStateStr;
    }
  }, [initialFilters]);

  /**
   * Record a new state in history
   * This should be called when filters are modified by user actions
   */
  const recordState = useCallback((newFilters: Filter[]) => {
    if (!shouldRecordRef.current) {
      // We're in the middle of undo/redo, don't record
      return;
    }

    const newStateStr = JSON.stringify(newFilters);
    
    // Skip if the state hasn't actually changed
    if (newStateStr === lastRecordedRef.current) {
      return;
    }

    setHistory((prev) => {
      const newPast = [...prev.past, prev.present];
      
      // Limit history size to prevent memory issues
      const trimmedPast = newPast.length > MAX_HISTORY_SIZE 
        ? newPast.slice(newPast.length - MAX_HISTORY_SIZE)
        : newPast;

      lastRecordedRef.current = newStateStr;

      return {
        past: trimmedPast,
        present: newFilters,
        future: [], // Clear future when a new change is made
      };
    });
  }, []);

  /**
   * Undo the last change
   * Returns the previous state or null if there's nothing to undo
   */
  const undo = useCallback((): Filter[] | null => {
    if (history.past.length === 0) {
      return null;
    }

    shouldRecordRef.current = false;

    let result: Filter[] | null = null;

    setHistory((prev) => {
      if (prev.past.length === 0) {
        return prev;
      }

      const previous = prev.past[prev.past.length - 1];
      const newPast = prev.past.slice(0, prev.past.length - 1);

      result = previous;
      lastRecordedRef.current = JSON.stringify(previous);

      return {
        past: newPast,
        present: previous,
        future: [prev.present, ...prev.future],
      };
    });

    // Re-enable recording after state update
    setTimeout(() => {
      shouldRecordRef.current = true;
    }, 0);

    return result;
  }, [history.past.length]);

  /**
   * Redo the last undone change
   * Returns the next state or null if there's nothing to redo
   */
  const redo = useCallback((): Filter[] | null => {
    if (history.future.length === 0) {
      return null;
    }

    shouldRecordRef.current = false;

    let result: Filter[] | null = null;

    setHistory((prev) => {
      if (prev.future.length === 0) {
        return prev;
      }

      const next = prev.future[0];
      const newFuture = prev.future.slice(1);

      result = next;
      lastRecordedRef.current = JSON.stringify(next);

      return {
        past: [...prev.past, prev.present],
        present: next,
        future: newFuture,
      };
    });

    // Re-enable recording after state update
    setTimeout(() => {
      shouldRecordRef.current = true;
    }, 0);

    return result;
  }, [history.future.length]);

  /**
   * Check if undo is available
   */
  const canUndo = history.past.length > 0;

  /**
   * Check if redo is available
   */
  const canRedo = history.future.length > 0;

  /**
   * Clear all history (useful when loading a new workflow)
   */
  const clearHistory = useCallback(() => {
    setHistory((prev) => ({
      past: [],
      present: prev.present,
      future: [],
    }));
    lastRecordedRef.current = JSON.stringify(history.present);
  }, [history.present]);

  return {
    filters: history.present,
    recordState,
    undo,
    redo,
    canUndo,
    canRedo,
    clearHistory,
  };
}
