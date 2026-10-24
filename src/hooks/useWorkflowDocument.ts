// src/hooks/useWorkflowDocument.ts - The window's workflow settings, and where each change is saved.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BackendId, QueueItem } from '../electron.d';
import { getErrorMessage } from '../types/errors';
import type { QueueSession } from '../utils/projectSnapshot';
import {
  editingItemIdOf,
  shownItemIdOf,
  viewOf,
  workflowDocumentReducer,
  type WorkflowDocumentState,
} from '../utils/workflowDocument';
import {
  adoptLegacySnapshot,
  configChanges,
  loadDocument,
  persistDocumentChange,
  projectConfigAside,
} from '../utils/workflowPersistence';
import {
  fromQueueWorkflow,
  renderSettingsOf,
  toQueueWorkflow,
  type ConfigField,
  type ConfigSettings,
  type WorkflowSettings,
} from '../utils/workflowSettings';
import {
  loadConfigSettings,
  readEditingItemId,
  readProjectConfigAside,
  readStoredBackend,
  saveConfigSetting,
  writeEditingItemId,
  writeLocalProject,
  writeProjectConfigAside,
} from '../utils/workflowStores';
import { useSyncReducer } from './useSyncReducer';

interface UseWorkflowDocumentOptions {
  isSetupComplete: boolean;
  /** The backend detection picked, for a first run with none saved. */
  recommendedBackend: BackendId | null;
  onLog: (message: string) => void;
  /** Save an edit to the queue item being edited. */
  onItemChange: (itemId: string, workflow: QueueItem['workflow']) => void;
}

/**
 * The settings the window works on, for the project or for one queue item.
 *
 * The project's settings are saved where they always were (localStorage and
 * app-config.json) and only change while the project is the target. A queue
 * item's are saved to the item. The config is also what the main process
 * renders, previews and validates with, so it follows the target (and a
 * rendering queue item); while it holds anything but the project's, the
 * project's are kept in localStorage too.
 */
export function useWorkflowDocument({ isSetupComplete, recommendedBackend, onLog, onItemChange }: UseWorkflowDocumentOptions) {
  // The item being edited when the app last closed, for App to go back to.
  const [resumeEditingId] = useState(readEditingItemId);

  const onItemChangeRef = useRef(onItemChange);
  onItemChangeRef.current = onItemChange;
  const onLogRef = useRef(onLog);
  onLogRef.current = onLog;

  // What the config holds, as far as this window knows; null until read.
  const configRef = useRef<Partial<ConfigSettings> | null>(null);
  // Config writes, in order.
  const configWritesRef = useRef<Promise<void>>(Promise.resolve());
  // The set-aside project settings as last written, or null when there are none.
  const asideRef = useRef<string | null>(null);
  if (asideRef.current === null) {
    const saved = readProjectConfigAside();
    if (saved) asideRef.current = JSON.stringify(saved);
  }

  const syncConfig = useCallback((state: WorkflowDocumentState, current: () => WorkflowDocumentState) => {
    const config = configRef.current;
    if (!state.loaded || !config) return;
    const changes = configChanges(state, config);
    for (const key of Object.keys(changes) as ConfigField[]) {
      const value = changes[key] as ConfigSettings[typeof key];
      (config as Record<string, unknown>)[key] = value;
      configWritesRef.current = configWritesRef.current
        .then(() => saveConfigSetting(key, value))
        .catch(error => onLogRef.current(`Error saving ${key}: ${getErrorMessage(error)}`));
    }

    const aside = projectConfigAside(state);
    if (aside) {
      const json = JSON.stringify(aside);
      if (json !== asideRef.current) {
        asideRef.current = json;
        writeProjectConfigAside(aside);
      }
    } else if (asideRef.current !== null) {
      // Dropped once the config holds the project's settings again.
      configWritesRef.current = configWritesRef.current.then(() => {
        if (projectConfigAside(current()) || asideRef.current === null) return;
        asideRef.current = null;
        writeProjectConfigAside(null);
      });
    }
  }, []);

  const [state, dispatch, getState] = useSyncReducer(
    workflowDocumentReducer,
    loadDocument,
    (next, previous) => {
      persistDocumentChange(next, previous, (itemId, workflow) => onItemChangeRef.current(itemId, workflow));
      syncConfig(next, getState);
    },
  );

  useEffect(() => {
    adoptLegacySnapshot(getState());
  }, [getState]);

  // Read the config-held settings once setup has finished.
  const loadStartedRef = useRef(false);
  useEffect(() => {
    if (!isSetupComplete || loadStartedRef.current) return;
    loadStartedRef.current = true;
    void loadConfigSettings().then(values => {
      configRef.current = { ...values };
      dispatch({ type: 'loaded', values });
      onLogRef.current('Workflow settings loaded');
    });
  }, [isSetupComplete, dispatch]);

  // First run: the backend detection recommends, once nothing is saved.
  useEffect(() => {
    if (recommendedBackend !== null && readStoredBackend() === null) {
      dispatch({ type: 'patchProject', patch: { defaultBackend: recommendedBackend } });
      // Saved even when it matches the assumed default, so detection decides only once.
      writeLocalProject(getState().project, ['defaultBackend']);
    }
  }, [recommendedBackend, dispatch, getState]);

  const patch = useCallback((change: Partial<WorkflowSettings>) => {
    dispatch({ type: 'patch', patch: change });
  }, [dispatch]);

  const undo = useCallback(() => {
    const before = getState();
    return dispatch({ type: 'undo' }) !== before;
  }, [dispatch, getState]);

  const redo = useCallback(() => {
    const before = getState();
    return dispatch({ type: 'redo' }) !== before;
  }, [dispatch, getState]);

  /** Work on a queue item's settings. Fields an older item lacks keep the current values. */
  const openItem = useCallback((id: string, workflow: QueueItem['workflow'], editable: boolean) => {
    dispatch({ type: 'openItem', id, editable, settings: fromQueueWorkflow(workflow, viewOf(getState())) });
  }, [dispatch, getState]);

  const showProject = useCallback(() => {
    dispatch({ type: 'showProject' });
  }, [dispatch]);

  const openSession = useCallback((session: QueueSession) => {
    dispatch({ type: 'openSession', session });
  }, [dispatch]);

  const closeSession = useCallback(() => {
    dispatch({ type: 'closeSession' });
  }, [dispatch]);

  /** Put a queue item's render settings in the config; resolves once they are written. */
  const beginItemRender = useCallback(async (workflow: QueueItem['workflow']): Promise<void> => {
    dispatch({ type: 'lockRender', settings: renderSettingsOf(workflow) });
    await configWritesRef.current;
  }, [dispatch]);

  /** Resolves once every config write made so far has finished. */
  const whenConfigSaved = useCallback(() => configWritesRef.current, []);

  /** Give the config back to the target's settings once a queue item has rendered. */
  const endItemRender = useCallback(() => {
    dispatch({ type: 'unlockRender' });
  }, [dispatch]);

  /** Stop going back to the item edited when the app last closed. */
  const forgetResume = useCallback(() => {
    if (!editingItemIdOf(getState())) writeEditingItemId(null);
  }, [getState]);

  /** The edit to save to the queue item being edited as the window closes, if one is. */
  const pendingItemSave = useCallback(() => {
    const current = getState();
    const itemId = editingItemIdOf(current);
    return itemId && current.item ? { itemId, workflow: toQueueWorkflow(current.item) } : undefined;
  }, [getState]);

  const view = viewOf(state);
  const editingItemId = editingItemIdOf(state);
  const shownItemId = shownItemIdOf(state);

  return useMemo(() => ({
    view,
    project: state.project,
    editingItemId,
    shownItemId,
    session: state.session,
    isLoaded: state.loaded,
    epoch: state.epoch,
    canUndo: state.history.past.length > 0,
    canRedo: state.history.future.length > 0,
    resumeEditingId,
    getState,
    patch,
    undo,
    redo,
    openItem,
    showProject,
    openSession,
    closeSession,
    beginItemRender,
    endItemRender,
    whenConfigSaved,
    pendingItemSave,
    forgetResume,
  }), [view, state.project, editingItemId, shownItemId, state.session, state.loaded, state.epoch,
      state.history.past.length, state.history.future.length, resumeEditingId, getState, patch, undo, redo,
      openItem, showProject, openSession, closeSession, beginItemRender, endItemRender, whenConfigSaved, pendingItemSave,
      forgetResume]);
}

export type WorkflowDocument = ReturnType<typeof useWorkflowDocument>;
