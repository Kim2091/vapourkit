// src/utils/filterHistory.ts - Undo and redo for the filter chain.

import type { Filter } from '../electron.d';

/** The chain (present) with the states before it (past, oldest first) and after it (future, nearest first). */
export interface FilterHistory {
  past: Filter[][];
  present: Filter[];
  future: Filter[][];
}

/** How many states undo can go back. */
export const MAX_HISTORY_SIZE = 50;

/** present, with nothing to undo or redo. */
export function startHistory(present: Filter[]): FilterHistory {
  return { past: [], present, future: [] };
}

/** next as a new undoable step. A chain equal to the present one records nothing. */
export function recordFilters(history: FilterHistory, next: Filter[]): FilterHistory {
  if (next === history.present || JSON.stringify(next) === JSON.stringify(history.present)) return history;
  const past = [...history.past, history.present];
  return {
    past: past.length > MAX_HISTORY_SIZE ? past.slice(past.length - MAX_HISTORY_SIZE) : past,
    present: next,
    future: [],
  };
}

/** One step back, or history itself when there is none. */
export function undoFilters(history: FilterHistory): FilterHistory {
  if (history.past.length === 0) return history;
  return {
    past: history.past.slice(0, -1),
    present: history.past[history.past.length - 1],
    future: [history.present, ...history.future],
  };
}

/** One step forward again, or history itself when there is none. */
export function redoFilters(history: FilterHistory): FilterHistory {
  if (history.future.length === 0) return history;
  return {
    past: [...history.past, history.present],
    present: history.future[0],
    future: history.future.slice(1),
  };
}
