import { useCallback } from 'react';
import type { Filter } from '../electron.d';
import { recordFilters, redoFilters, startHistory, undoFilters, type FilterHistory } from '../utils/filterHistory';
import { useSyncReducer } from './useSyncReducer';
import { useUndoRedoShortcuts } from './useUndoRedoShortcuts';

interface ChainState {
  history: FilterHistory;
  /**
   * Which chain the window holds. Bumped whenever a different one is swapped
   * in (a queue item's, the project's back), so a result started on one chain
   * is not applied to another that happens to share step ids, as a queue item
   * copied from the project does.
   */
  epoch: number;
}

type ChainAction =
  | { type: 'record'; filters: Filter[] }
  | { type: 'replace'; filters: Filter[] }
  | { type: 'undo' }
  | { type: 'redo' };

function chainReducer(state: ChainState, action: ChainAction): ChainState {
  switch (action.type) {
    case 'record': {
      const history = recordFilters(state.history, action.filters);
      return history === state.history ? state : { ...state, history };
    }
    case 'replace':
      return { history: startHistory(action.filters), epoch: state.epoch + 1 };
    case 'undo': {
      const history = undoFilters(state.history);
      return history === state.history ? state : { ...state, history };
    }
    case 'redo': {
      const history = redoFilters(state.history);
      return history === state.history ? state : { ...state, history };
    }
  }
}

function readStoredFilters(): Filter[] {
  try {
    const saved = localStorage.getItem('filters');
    return saved !== null ? JSON.parse(saved) : [];
  } catch {
    return [];
  }
}

export function useFilterConfig(
  isSetupComplete: boolean,
  onLog: (message: string) => void
) {
  // The chain is saved as part of every change rather than by an effect: a
  // step's code still being typed is committed as the window closes, and no
  // render (so no effect) follows that.
  const [state, dispatch, getState] = useSyncReducer(
    chainReducer,
    () => ({ history: startHistory(readStoredFilters()), epoch: 0 }),
    (next, previous) => {
      if (next.history.present === previous.history.present) return;
      try {
        localStorage.setItem('filters', JSON.stringify(next.history.present));
      } catch {
        // Storage full or blocked: the chain still works for this session.
      }
    },
  );

  // A change made by the user: saved, and a step undo can go back over.
  const handleSetFilters = useCallback((value: Filter[]) => {
    dispatch({ type: 'record', filters: value });
  }, [dispatch]);

  // Swap in a different chain (a queue item's, or the project's back again):
  // saved like any change, but a fresh start for undo.
  const replaceFilters = useCallback((value: Filter[]) => {
    dispatch({ type: 'replace', filters: value });
  }, [dispatch]);

  /**
   * Start work on one step that will change it later. The function returned
   * applies the change to that step as the chain is when the work finishes,
   * keeping every other edit made meanwhile, and does nothing (returning
   * false) if the step is gone or a different chain has been swapped in.
   */
  const beginStepPatch = useCallback((stepId: string) => {
    const startedOn = getState().epoch;
    return (patch: (step: Filter) => Filter): boolean => {
      const { epoch, history } = getState();
      if (epoch !== startedOn) return false;
      if (!history.present.some(step => step.id === stepId)) return false;
      dispatch({ type: 'record', filters: history.present.map(step => step.id === stepId ? patch(step) : step) });
      return true;
    };
  }, [dispatch, getState]);

  /** The chain including changes not rendered yet (a code edit committed as the window closes). */
  const getLatestFilters = useCallback(() => getState().history.present, [getState]);

  const handleUndo = useCallback(() => {
    const before = getState();
    if (dispatch({ type: 'undo' }) !== before) onLog('Undo filter change');
  }, [dispatch, getState, onLog]);

  const handleRedo = useCallback(() => {
    const before = getState();
    if (dispatch({ type: 'redo' }) !== before) onLog('Redo filter change');
  }, [dispatch, getState, onLog]);

  // Setup keyboard shortcuts for undo/redo
  useUndoRedoShortcuts({
    onUndo: handleUndo,
    onRedo: handleRedo,
    enabled: isSetupComplete,
  });

  return {
    filters: state.history.present,
    handleSetFilters,
    replaceFilters,
    beginStepPatch,
    getLatestFilters,
    chainEpoch: state.epoch,
    canUndo: state.history.past.length > 0,
    canRedo: state.history.future.length > 0,
    handleUndo,
    handleRedo,
  };
}
