// src/hooks/useColorGrade.ts — live grade values for the open grade step.
//
// The filter's parameters stay the source of truth, but a trackball drag fires
// far more often than the undo history should record. So the draft lives here
// while the gesture runs and is committed once when it ends: the picture and
// the scopes follow every pixel of the drag, while filters/history see one
// change per gesture.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ColorGradeFilterEditor, Filter, FilterParameterValues } from '../electron.d';
import {
  GRADE_NEUTRAL,
  gradeFromParameters,
  gradeToParameters,
  isNeutralGrade,
  type GradeValues,
} from '../utils/colorGrade';

interface UseColorGradeOptions {
  /** The filter whose template asked for the grading dock, if one is open. */
  filter: Filter | null;
  onParametersChange?: (filterId: string, parameters: FilterParameterValues) => void;
}

export interface UseColorGradeResult {
  editor: ColorGradeFilterEditor | null;
  values: GradeValues;
  isNeutral: boolean;
  /** Updates the draft without touching the filter — use during a gesture. */
  setValues: (values: GradeValues) => void;
  /** Ends a gesture: writes the draft into the filter's parameters. */
  commit: () => void;
  /** Sets and commits in one step, for controls with no drag. */
  apply: (values: GradeValues) => void;
  resetAll: () => void;
}

export function isColorGradeEditor(
  editor: Filter['editor'] | undefined,
): editor is ColorGradeFilterEditor {
  return editor?.type === 'colorGrade';
}

export function useColorGrade({ filter, onParametersChange }: UseColorGradeOptions): UseColorGradeResult {
  const editor = isColorGradeEditor(filter?.editor) ? filter!.editor : null;

  const stored = useMemo(
    () => (editor ? gradeFromParameters(editor, filter?.parameters) : GRADE_NEUTRAL),
    [editor, filter?.parameters],
  );

  const [draft, setDraft] = useState<GradeValues | null>(null);
  const draftRef = useRef<GradeValues | null>(null);
  const filterIdRef = useRef<string | null>(null);

  // Opening a different grade step, or closing the dock, drops any draft —
  // otherwise one filter's values would briefly show under another's name.
  useEffect(() => {
    const id = filter?.id ?? null;
    if (filterIdRef.current !== id) {
      filterIdRef.current = id;
      draftRef.current = null;
      setDraft(null);
    }
  }, [filter?.id]);

  const values = draft ?? stored;

  const setValues = useCallback((next: GradeValues) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  const commit = useCallback(() => {
    const pending = draftRef.current;
    if (!pending || !editor || !filter || !onParametersChange) return;
    draftRef.current = null;
    setDraft(null);
    onParametersChange(filter.id, gradeToParameters(editor, pending, filter.parameters));
  }, [editor, filter, onParametersChange]);

  const apply = useCallback((next: GradeValues) => {
    if (!editor || !filter || !onParametersChange) return;
    draftRef.current = null;
    setDraft(null);
    onParametersChange(filter.id, gradeToParameters(editor, next, filter.parameters));
  }, [editor, filter, onParametersChange]);

  const resetAll = useCallback(() => apply(GRADE_NEUTRAL), [apply]);

  return {
    editor,
    values,
    isNeutral: isNeutralGrade(values),
    setValues,
    commit,
    apply,
    resetAll,
  };
}
