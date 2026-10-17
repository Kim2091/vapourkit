// src/utils/workflowPersistence.ts - Loading the workflow document, and saving each change where it belongs.

import type { QueueItem } from '../electron.d';
import { projectFromSnapshot, sessionOf, toPreQueueSnapshot, type QueueSession } from './projectSnapshot';
import {
  desiredConfigOf,
  editingItemIdOf,
  initialDocument,
  projectConfigAtRisk,
  type WorkflowDocumentState,
} from './workflowDocument';
import {
  CONFIG_FIELDS,
  configSettingsOf,
  DEFAULT_SETTINGS,
  LOCAL_FIELDS,
  sameValue,
  toQueueWorkflow,
  type ConfigField,
  type ConfigSettings,
} from './workflowSettings';
import {
  readLocalProject,
  readPreQueueSnapshot,
  readProjectConfigAside,
  writeEditingItemId,
  writeLocalProject,
  writePreQueueSnapshot,
} from './workflowStores';

/**
 * The document as saved: the project from localStorage, with the pre-queue
 * record and the set-aside config settings over it. Both of those hold the
 * project's settings while the saved ones may be a queue item's.
 */
export function loadDocument(): WorkflowDocumentState {
  let project = readLocalProject(DEFAULT_SETTINGS);
  let settled: ConfigField[] = [];
  let session: QueueSession | null = null;
  const snapshot = readPreQueueSnapshot();
  if (snapshot) {
    ({ project, configFields: settled } = projectFromSnapshot(snapshot, project));
    session = sessionOf(snapshot);
  }
  const aside = readProjectConfigAside();
  if (aside) {
    project = { ...project, ...configSettingsOf(aside) };
    settled = CONFIG_FIELDS.filter(key => settled.includes(key) || aside[key] !== undefined);
  }
  return initialDocument(project, settled, session);
}

/**
 * A pre-queue record from before it was kept level with the project is the
 * project, while localStorage may hold a queue item's settings. Saves it as
 * the project's, so closing the queue cannot lose it.
 */
export function adoptLegacySnapshot(state: WorkflowDocumentState): void {
  const snapshot = readPreQueueSnapshot();
  if (!snapshot || snapshot.version === 2 || !state.session) return;
  writeLocalProject(state.project, snapshot.defaultBackend ? [...LOCAL_FIELDS] : ['filters', 'numStreams']);
  writePreQueueSnapshot(toPreQueueSnapshot(state.session, state.project));
}

/**
 * Save what changed from previous to next, synchronously: the project's
 * localStorage settings, the edited queue item (through onItemChange), which
 * item is being edited, and the pre-queue record while the queue is open.
 * The config is written separately (configChanges), since that is async.
 */
export function persistDocumentChange(
  next: WorkflowDocumentState,
  previous: WorkflowDocumentState,
  onItemChange: (itemId: string, workflow: QueueItem['workflow']) => void,
): void {
  if (next.project !== previous.project) {
    writeLocalProject(next.project, LOCAL_FIELDS.filter(key => !sameValue(next.project[key], previous.project[key])));
  }

  const editing = editingItemIdOf(next);
  if (editing && editing === editingItemIdOf(previous) && next.item && next.item !== previous.item) {
    onItemChange(editing, toQueueWorkflow(next.item));
  }
  if (editing !== editingItemIdOf(previous)) writeEditingItemId(editing);

  if (next.session !== previous.session || (next.session && next.project !== previous.project)) {
    writePreQueueSnapshot(next.session ? toPreQueueSnapshot(next.session, next.project) : null);
  }
}

/** The config settings to write so the config holds what state wants it to. */
export function configChanges(state: WorkflowDocumentState, config: Partial<ConfigSettings>): Partial<ConfigSettings> {
  const desired = desiredConfigOf(state);
  const changes: Partial<ConfigSettings> = {};
  for (const key of CONFIG_FIELDS) {
    if (!sameValue(desired[key], config[key])) (changes as Record<string, unknown>)[key] = desired[key];
  }
  return changes;
}

/**
 * The project's config settings to keep in localStorage, or null once the
 * config holds them itself.
 */
export function projectConfigAside(state: WorkflowDocumentState): Partial<ConfigSettings> | null {
  return projectConfigAtRisk(state) ? configSettingsOf(state.project) : null;
}
