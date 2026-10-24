// src/utils/workflowSettings.ts - The settings a render is made with, and their stored forms.

import type { BackendId, ColorimetrySettings, Filter, QueueItem, SegmentSelection, WorkflowData } from '../electron.d';
import {
  DEFAULT_ENCODING,
  encodingFrom,
  resolveEncodingArgs,
  type EncodingSettings,
} from '../../electron/encodingSettings';
import { isBackendId, normalizeBackendForCurrentPlatform } from './backends';

/** Everything that decides what a render produces, for the project or one queue item. */
export interface WorkflowSettings {
  selectedModel: string | null;
  filters: Filter[];
  encoding: EncodingSettings;
  processingFormat: string;
  outputFormat: string;
  videoCompareArgs: string;
  defaultBackend: BackendId;
  numStreams: number;
  segment: SegmentSelection;
  colorimetry: ColorimetrySettings;
}

/**
 * The settings kept in app-config.json. The main process reads them from
 * there for every render, preview and validation, so the config always holds
 * the settings being worked on (or, during a queue run, the running item's).
 */
export const CONFIG_FIELDS = ['encoding', 'processingFormat', 'outputFormat', 'videoCompareArgs', 'colorimetry'] as const;
export type ConfigField = typeof CONFIG_FIELDS[number];
export type ConfigSettings = Pick<WorkflowSettings, ConfigField>;

/** The settings kept in localStorage. */
export const LOCAL_FIELDS = ['filters', 'numStreams', 'defaultBackend'] as const;
export type LocalField = typeof LOCAL_FIELDS[number];

export const WHOLE_VIDEO: SegmentSelection = { enabled: false, startFrame: 0, endFrame: -1 };

export const DEFAULT_COLORIMETRY: ColorimetrySettings = {
  overwriteMatrix: false,
  matrix709: false,
  defaultMatrix: '709',
  defaultPrimaries: '709',
  defaultTransfer: '709',
};

export const DEFAULT_SETTINGS: WorkflowSettings = {
  selectedModel: null,
  filters: [],
  encoding: DEFAULT_ENCODING,
  processingFormat: 'vs.YUV420P8',
  outputFormat: 'mkv',
  videoCompareArgs: '-W',
  defaultBackend: 'tensorrt',
  numStreams: 2,
  segment: WHOLE_VIDEO,
  colorimetry: DEFAULT_COLORIMETRY,
};

/** Whether two values are the same setting (settings are plain JSON). */
export function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** The keys of patch whose values differ from settings'. */
export function changedKeys<T extends object>(settings: T, patch: Partial<T>): (keyof T)[] {
  return (Object.keys(patch) as (keyof T)[])
    .filter(key => patch[key] !== undefined && !sameValue(settings[key], patch[key]));
}

export function configSettingsOf(settings: Partial<WorkflowSettings>): Partial<ConfigSettings> {
  const picked: Partial<ConfigSettings> = {};
  for (const key of CONFIG_FIELDS) {
    if (settings[key] !== undefined) (picked as Record<string, unknown>)[key] = settings[key];
  }
  return picked;
}

/** A queue item's workflow for settings: a copy, with the segment only when one is selected. */
export function toQueueWorkflow(settings: WorkflowSettings): QueueItem['workflow'] {
  return {
    selectedModel: settings.selectedModel,
    filters: structuredClone(settings.filters),
    encoding: structuredClone(settings.encoding),
    ffmpegArgs: resolveEncodingArgs(settings.encoding),
    processingFormat: settings.processingFormat,
    outputFormat: settings.outputFormat,
    videoCompareArgs: settings.videoCompareArgs,
    defaultBackend: settings.defaultBackend,
    numStreams: settings.numStreams,
    segment: settings.segment.enabled ? { ...settings.segment } : undefined,
    colorimetry: settings.colorimetry,
  };
}

/**
 * The settings a queue item carries. Older items lack some fields; those are
 * taken from fallback, and a legacy useDirectML backend and an encoding kept
 * only as ffmpegArgs are migrated.
 */
export function fromQueueWorkflow(workflow: QueueItem['workflow'], fallback: WorkflowSettings): WorkflowSettings {
  return {
    selectedModel: workflow.selectedModel ?? null,
    filters: structuredClone(workflow.filters ?? []),
    encoding: encodingOfItem(workflow) ?? fallback.encoding,
    processingFormat: typeof workflow.processingFormat === 'string' ? workflow.processingFormat : fallback.processingFormat,
    outputFormat: workflow.outputFormat || fallback.outputFormat,
    videoCompareArgs: typeof workflow.videoCompareArgs === 'string' ? workflow.videoCompareArgs : fallback.videoCompareArgs,
    defaultBackend: normalizeBackendForCurrentPlatform(workflow.defaultBackend ?? workflow.useDirectML),
    numStreams: typeof workflow.numStreams === 'number' ? workflow.numStreams : fallback.numStreams,
    segment: workflow.segment?.enabled ? { ...workflow.segment } : WHOLE_VIDEO,
    colorimetry: workflow.colorimetry ?? fallback.colorimetry,
  };
}

/**
 * A saved queue item's workflow in the current form: a legacy useDirectML
 * backend becomes a backend id, and an encoding kept only as ffmpegArgs
 * becomes encoding settings. The same object when nothing needed migrating.
 */
export function migrateQueueWorkflow(workflow: QueueItem['workflow']): QueueItem['workflow'] {
  const defaultBackend = normalizeBackendForCurrentPlatform(workflow.defaultBackend ?? workflow.useDirectML);
  const encoding = encodingOfItem(workflow);
  const backendCurrent = workflow.defaultBackend === defaultBackend && workflow.useDirectML === undefined;
  const encodingCurrent = !encoding || sameValue(encoding, workflow.encoding);
  if (backendCurrent && encodingCurrent) return workflow;
  return {
    ...workflow,
    defaultBackend,
    useDirectML: undefined,
    ...(encoding ? { encoding, ffmpegArgs: resolveEncodingArgs(encoding) } : {}),
  };
}

/** A queue item's encoding settings, or null when it carries none. */
function encodingOfItem(workflow: QueueItem['workflow']): EncodingSettings | null {
  return encodingFrom(workflow.encoding, workflow.ffmpegArgs);
}

/** The settings a render of a queue item reads from the config: only the ones the item carries. */
export function renderSettingsOf(workflow: QueueItem['workflow']): Partial<ConfigSettings> {
  const settings: Partial<ConfigSettings> = {};
  const encoding = encodingOfItem(workflow);
  if (encoding) settings.encoding = encoding;
  if (typeof workflow.processingFormat === 'string') settings.processingFormat = workflow.processingFormat;
  if (workflow.colorimetry) settings.colorimetry = workflow.colorimetry;
  return settings;
}

type WorkflowEncodingSettings = NonNullable<WorkflowData['encodingSettings']>;

/** A workflow file's encoding settings for settings. */
export function encodingSettingsOf(settings: WorkflowSettings): WorkflowEncodingSettings {
  return {
    encoding: settings.encoding,
    ffmpegArgs: resolveEncodingArgs(settings.encoding),
    processingFormat: settings.processingFormat,
    outputFormat: settings.outputFormat,
    videoCompareArgs: settings.videoCompareArgs,
    defaultBackend: settings.defaultBackend,
    numStreams: settings.numStreams,
    segment: settings.segment,
    colorimetry: settings.colorimetry,
  };
}

/** What loading a workflow file's encoding settings changes. Empty or invalid values are skipped. */
export function encodingPatchOf(encoding: WorkflowData['encodingSettings']): Partial<WorkflowSettings> {
  const patch: Partial<WorkflowSettings> = {};
  if (!encoding) return patch;
  const videoEncoding = encodingFrom(encoding.encoding, encoding.ffmpegArgs || undefined);
  if (videoEncoding) patch.encoding = videoEncoding;
  if (encoding.processingFormat) patch.processingFormat = encoding.processingFormat;
  if (encoding.outputFormat) patch.outputFormat = encoding.outputFormat;
  if (encoding.videoCompareArgs) patch.videoCompareArgs = encoding.videoCompareArgs;
  if (encoding.numStreams) patch.numStreams = encoding.numStreams;
  if (encoding.segment) patch.segment = encoding.segment;
  if (encoding.colorimetry) patch.colorimetry = encoding.colorimetry;
  if (encoding.defaultBackend && isBackendId(encoding.defaultBackend)) {
    patch.defaultBackend = normalizeBackendForCurrentPlatform(encoding.defaultBackend);
  }
  return patch;
}

/** The localStorage record of a loaded workflow: its name, where it went, and what it replaced there. */
export interface LoadedWorkflowRecord {
  currentWorkflow: string | null;
  /** What the workflow was loaded into: 'project', or the queue item being edited. */
  context?: string;
  previousFilters: Filter[];
  previousModel: string | null;
  previousEncodingSettings?: {
    defaultBackend?: BackendId;
    encoding?: EncodingSettings;
    /** What encoding resolves to; the only encoding field of older records. */
    ffmpegArgs?: string;
    processingFormat: string;
    outputFormat: string;
    videoCompareArgs: string;
    numStreams: number;
    segment: SegmentSelection;
    colorimetry: ColorimetrySettings;
  };
}

export const NO_WORKFLOW: LoadedWorkflowRecord = { currentWorkflow: null, previousFilters: [], previousModel: null };

/** The record for loading workflowName into context over settings. */
export function loadedWorkflowRecord(workflowName: string, context: string, settings: WorkflowSettings): LoadedWorkflowRecord {
  return {
    currentWorkflow: workflowName,
    context,
    previousFilters: structuredClone(settings.filters),
    previousModel: settings.selectedModel,
    previousEncodingSettings: {
      defaultBackend: settings.defaultBackend,
      encoding: settings.encoding,
      ffmpegArgs: resolveEncodingArgs(settings.encoding),
      processingFormat: settings.processingFormat,
      outputFormat: settings.outputFormat,
      videoCompareArgs: settings.videoCompareArgs,
      numStreams: settings.numStreams,
      segment: settings.segment,
      colorimetry: settings.colorimetry,
    },
  };
}

/** What clearing the loaded workflow puts back. A record without a model leaves the model as it is. */
export function restorePatchOf(record: LoadedWorkflowRecord): Partial<WorkflowSettings> {
  const patch: Partial<WorkflowSettings> = { filters: structuredClone(record.previousFilters) };
  if (record.previousModel) patch.selectedModel = record.previousModel;
  const previous = record.previousEncodingSettings;
  if (previous) {
    if (previous.defaultBackend) patch.defaultBackend = previous.defaultBackend;
    const encoding = encodingFrom(previous.encoding, previous.ffmpegArgs);
    if (encoding) patch.encoding = encoding;
    patch.processingFormat = previous.processingFormat;
    patch.outputFormat = previous.outputFormat;
    patch.videoCompareArgs = previous.videoCompareArgs;
    patch.numStreams = previous.numStreams;
    patch.segment = previous.segment;
    patch.colorimetry = previous.colorimetry;
  }
  return patch;
}
