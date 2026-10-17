// src/hooks/useSyncReducer.ts - A reducer whose latest state can be read at once.

import { useCallback, useRef, useState } from 'react';

/**
 * useReducer, except that dispatch applies the action straight away and get()
 * returns the state as of the last dispatch, ahead of the render that shows
 * it. For work that has to read or act on the state from outside a render: a
 * job that finishes later, or a save as the window closes. onChange runs
 * synchronously after every dispatch that changed the state.
 */
export function useSyncReducer<S, A>(
  reducer: (state: S, action: A) => S,
  init: () => S,
  onChange?: (next: S, previous: S) => void,
): [S, (action: A) => S, () => S] {
  const stateRef = useRef<S | null>(null);
  if (stateRef.current === null) stateRef.current = init();
  const [state, setState] = useState<S>(stateRef.current);

  const reducerRef = useRef(reducer);
  reducerRef.current = reducer;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const dispatch = useCallback((action: A): S => {
    const previous = stateRef.current as S;
    const next = reducerRef.current(previous, action);
    if (next !== previous) {
      stateRef.current = next;
      setState(next);
      onChangeRef.current?.(next, previous);
    }
    return next;
  }, []);

  const get = useCallback(() => stateRef.current as S, []);

  return [state, dispatch, get];
}
