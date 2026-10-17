// src/utils/workflowDocument.ts - The settings the window works on: the project's, or one queue item's.

import type { QueueSession } from './projectSnapshot';
import { recordFilters, redoFilters, startHistory, undoFilters, type FilterHistory } from './filterHistory';
import { changedKeys, CONFIG_FIELDS, type ConfigField, type ConfigSettings, type WorkflowSettings } from './workflowSettings';

/** What the window's settings belong to. A queue item that has started or finished is only looked at. */
export type WorkflowTarget =
  | { kind: 'project' }
  | { kind: 'item'; id: string; editable: boolean };

export interface WorkflowDocumentState {
  /** The project's settings. Changed only while it is the target, or by loading what was saved. */
  project: WorkflowSettings;
  target: WorkflowTarget;
  /** The queue item's settings while one is the target. */
  item: WorkflowSettings | null;
  /** Undo and redo for the target's chain; present is always the target's filters. */
  history: FilterHistory;
  /**
   * Which chain the window holds. Bumped whenever a different one is swapped
   * in, so a result started on one chain is not applied to another that
   * happens to share step ids, as a queue item copied from the project does.
   */
  epoch: number;
  /** Whether the project's config-held settings have been read. */
  loaded: boolean;
  /** Config-held project settings already decided, which the read must not replace. */
  settled: ConfigField[];
  /** The project's video while the queue is open. */
  session: QueueSession | null;
  /** A queue item's render settings, held in the config while it renders. */
  renderLock: Partial<ConfigSettings> | null;
}

export type WorkflowDocumentAction =
  /** Change the target's settings. A new chain is a step undo can go back over. */
  | { type: 'patch'; patch: Partial<WorkflowSettings> }
  /** Change the project's settings, whatever the target. */
  | { type: 'patchProject'; patch: Partial<WorkflowSettings> }
  | { type: 'undo' }
  | { type: 'redo' }
  /** Work on a queue item's settings; the project's stay as they are. */
  | { type: 'openItem'; id: string; settings: WorkflowSettings; editable: boolean }
  /** Work on the project's settings again. */
  | { type: 'showProject' }
  /** The project's config-held settings as read at launch. */
  | { type: 'loaded'; values: Partial<ConfigSettings> }
  | { type: 'openSession'; session: QueueSession }
  | { type: 'closeSession' }
  | { type: 'lockRender'; settings: Partial<ConfigSettings> }
  | { type: 'unlockRender' };

export function initialDocument(project: WorkflowSettings, settled: ConfigField[] = [], session: QueueSession | null = null): WorkflowDocumentState {
  return {
    project,
    target: { kind: 'project' },
    item: null,
    history: startHistory(project.filters),
    epoch: 0,
    loaded: false,
    settled,
    session,
    renderLock: null,
  };
}

/** The settings the window shows and edits. */
export function viewOf(state: WorkflowDocumentState): WorkflowSettings {
  return state.target.kind === 'item' && state.item ? state.item : state.project;
}

/** The id of the queue item whose edits are saved to it, or null. */
export function editingItemIdOf(state: WorkflowDocumentState): string | null {
  return state.target.kind === 'item' && state.target.editable ? state.target.id : null;
}

/** The id of the queue item shown, editable or not, or null. */
export function shownItemIdOf(state: WorkflowDocumentState): string | null {
  return state.target.kind === 'item' ? state.target.id : null;
}

/** The target's settings replaced by view, its history by history. */
function withView(state: WorkflowDocumentState, view: WorkflowSettings, history: FilterHistory): WorkflowDocumentState {
  if (state.target.kind === 'item') return { ...state, item: view, history };
  return { ...state, project: view, history };
}

function patchSettings(settings: WorkflowSettings, patch: Partial<WorkflowSettings>): WorkflowSettings | null {
  const keys = changedKeys(settings, patch);
  if (keys.length === 0) return null;
  const next = { ...settings };
  for (const key of keys) (next as Record<string, unknown>)[key] = patch[key];
  return next;
}

export function workflowDocumentReducer(state: WorkflowDocumentState, action: WorkflowDocumentAction): WorkflowDocumentState {
  switch (action.type) {
    case 'patch': {
      const view = viewOf(state);
      const { filters, ...rest } = action.patch;
      let history = state.history;
      if (filters !== undefined) history = recordFilters(state.history, filters);
      const next = patchSettings(view, { ...rest, filters: history.present });
      if (!next) return state;
      const patched = withView(state, next, history);
      if (state.target.kind === 'project' && !state.loaded) {
        const settled = CONFIG_FIELDS.filter(key => state.settled.includes(key) || key in rest);
        return { ...patched, settled };
      }
      return patched;
    }

    case 'patchProject': {
      if (state.target.kind === 'project') return workflowDocumentReducer(state, { type: 'patch', patch: action.patch });
      const project = patchSettings(state.project, action.patch);
      return project ? { ...state, project } : state;
    }

    case 'undo':
    case 'redo': {
      const history = action.type === 'undo' ? undoFilters(state.history) : redoFilters(state.history);
      if (history === state.history) return state;
      return withView(state, { ...viewOf(state), filters: history.present }, history);
    }

    case 'openItem':
      return {
        ...state,
        target: { kind: 'item', id: action.id, editable: action.editable },
        item: action.settings,
        history: startHistory(action.settings.filters),
        epoch: state.epoch + 1,
      };

    case 'showProject':
      if (state.target.kind === 'project') return state;
      return {
        ...state,
        target: { kind: 'project' },
        item: null,
        history: startHistory(state.project.filters),
        epoch: state.epoch + 1,
      };

    case 'loaded': {
      const values: Partial<ConfigSettings> = {};
      for (const key of CONFIG_FIELDS) {
        if (action.values[key] !== undefined && !state.settled.includes(key)) {
          (values as Record<string, unknown>)[key] = action.values[key];
        }
      }
      const project = patchSettings(state.project, values) ?? state.project;
      return { ...state, project, loaded: true };
    }

    case 'openSession':
      return { ...state, session: action.session };

    case 'closeSession':
      return state.session ? { ...state, session: null } : state;

    case 'lockRender':
      return { ...state, renderLock: action.settings };

    case 'unlockRender':
      return state.renderLock ? { ...state, renderLock: null } : state;
  }
}

/**
 * What the config should hold: the target's settings, with a rendering queue
 * item's own over them while it renders.
 */
export function desiredConfigOf(state: WorkflowDocumentState): ConfigSettings {
  const view = viewOf(state);
  const desired = {} as ConfigSettings;
  for (const key of CONFIG_FIELDS) (desired as Record<string, unknown>)[key] = view[key];
  return { ...desired, ...state.renderLock };
}

/**
 * Whether the config may hold settings other than the project's (a queue
 * item is the target, or one is rendering), so the project's have to be kept
 * somewhere else in case the app does not get to put them back.
 */
export function projectConfigAtRisk(state: WorkflowDocumentState): boolean {
  return state.target.kind === 'item' || state.renderLock !== null;
}
