import { useCallback } from 'react';
import type { Filter } from '../electron.d';
import { viewOf } from '../utils/workflowDocument';
import type { WorkflowDocument } from './useWorkflowDocument';
import { useUndoRedoShortcuts } from './useUndoRedoShortcuts';

/**
 * The window's filter chain, with undo and redo: the target's chain in the
 * workflow document, whose history starts fresh whenever another chain is
 * swapped in.
 */
export function useFilterConfig(
  workflow: WorkflowDocument,
  isSetupComplete: boolean,
  onLog: (message: string) => void
) {
  const { patch, getState, undo, redo } = workflow;

  // A change made by the user: saved where the target keeps it, and a step undo can go back over.
  const handleSetFilters = useCallback((value: Filter[]) => {
    patch({ filters: value });
  }, [patch]);

  /**
   * Start work on one step that will change it later. The function returned
   * applies the change to that step as the chain is when the work finishes,
   * keeping every other edit made meanwhile, and does nothing (returning
   * false) if the step is gone or a different chain has been swapped in.
   */
  const beginStepPatch = useCallback((stepId: string) => {
    const startedOn = getState().epoch;
    return (change: (step: Filter) => Filter): boolean => {
      const current = getState();
      if (current.epoch !== startedOn) return false;
      const filters = viewOf(current).filters;
      if (!filters.some(step => step.id === stepId)) return false;
      patch({ filters: filters.map(step => step.id === stepId ? change(step) : step) });
      return true;
    };
  }, [getState, patch]);

  const handleUndo = useCallback(() => {
    if (undo()) onLog('Undo filter change');
  }, [undo, onLog]);

  const handleRedo = useCallback(() => {
    if (redo()) onLog('Redo filter change');
  }, [redo, onLog]);

  // Setup keyboard shortcuts for undo/redo
  useUndoRedoShortcuts({
    onUndo: handleUndo,
    onRedo: handleRedo,
    enabled: isSetupComplete,
  });

  return {
    filters: workflow.view.filters,
    handleSetFilters,
    beginStepPatch,
    chainEpoch: workflow.epoch,
    canUndo: workflow.canUndo,
    canRedo: workflow.canRedo,
    handleUndo,
    handleRedo,
  };
}
