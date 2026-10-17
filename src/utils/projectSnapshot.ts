// src/utils/projectSnapshot.ts - The project's video and settings, kept while the queue is open.

import type { BackendId, SegmentSelection } from '../electron.d';
import { normalizeBackendForCurrentPlatform } from './backends';
import { outputPathFor, type OutputNaming, type OutputNamingVideo, type OutputNamingWorkflow } from './queueOutputPath';
import { CONFIG_FIELDS, WHOLE_VIDEO, type ConfigField, type WorkflowSettings } from './workflowSettings';

/**
 * The localStorage form ('preQueueWorkflow'). Version 2 is kept level with
 * the project for as long as the queue is open. Older ones were written once,
 * as the queue opened, while the window went on to save queue items' settings
 * over the project's: for those this record is the project.
 */
export type PreQueueWorkflow = {
  version?: 2;
  videoPath: string | null;
  /** The path the window showed, kept for versions that read only this. */
  outputPath: string | null;
  /** The path the user chose for the project's video, or null when it was named automatically. */
  outputPathOverride?: string | null;
  selectedModel: string | null;
  filters: any[];
  outputFormat: string;
  defaultBackend: BackendId;
  numStreams: number;
  segment: SegmentSelection;
  ffmpegArgs?: string;
  processingFormat?: string;
  videoCompareArgs?: string;
  colorimetry?: any;
};

/** The project's video while the queue is open and the window may show a queue item's. */
export interface QueueSession {
  videoPath: string | null;
  /** The path the window showed for it. */
  outputPath: string | null;
  /** The path the user chose for it, null when named automatically, undefined when an older record did not say. */
  outputPathOverride?: string | null;
}

export function toPreQueueSnapshot(session: QueueSession, project: WorkflowSettings): PreQueueWorkflow {
  return {
    version: 2,
    videoPath: session.videoPath,
    outputPath: session.outputPath,
    outputPathOverride: session.outputPathOverride,
    selectedModel: project.selectedModel,
    filters: project.filters,
    outputFormat: project.outputFormat,
    defaultBackend: project.defaultBackend,
    numStreams: project.numStreams,
    segment: project.segment,
    ffmpegArgs: project.ffmpegArgs,
    processingFormat: project.processingFormat,
    videoCompareArgs: project.videoCompareArgs,
    colorimetry: project.colorimetry,
  };
}

export function sessionOf(snapshot: PreQueueWorkflow): QueueSession {
  return {
    videoPath: snapshot.videoPath ?? null,
    outputPath: snapshot.outputPath ?? null,
    outputPathOverride: snapshot.outputPathOverride,
  };
}

/** base with the project settings snapshot carries; also which config-held settings it carried. */
export function projectFromSnapshot(
  snapshot: PreQueueWorkflow,
  base: WorkflowSettings,
): { project: WorkflowSettings; configFields: ConfigField[] } {
  const project: WorkflowSettings = {
    ...base,
    selectedModel: snapshot.selectedModel ?? base.selectedModel,
    filters: Array.isArray(snapshot.filters) ? snapshot.filters : base.filters,
    defaultBackend: snapshot.defaultBackend ? normalizeBackendForCurrentPlatform(snapshot.defaultBackend) : base.defaultBackend,
    numStreams: typeof snapshot.numStreams === 'number' ? snapshot.numStreams : base.numStreams,
    segment: snapshot.segment ?? WHOLE_VIDEO,
  };
  const configFields: ConfigField[] = [];
  for (const key of CONFIG_FIELDS) {
    const value = snapshot[key];
    if (value !== undefined && value !== null) {
      (project as unknown as Record<string, unknown>)[key] = value;
      configFields.push(key);
    }
  }
  return { project, configFields };
}

/**
 * The output path the user chose for the session's video, or null when it was
 * named automatically. A session from an older record carries only the path
 * shown, which counts as chosen when it is not the automatic name.
 */
export function projectOutputOverride(
  session: QueueSession,
  video: OutputNamingVideo,
  workflow: OutputNamingWorkflow,
  naming: OutputNaming,
): string | null {
  if (session.outputPathOverride !== undefined) return session.outputPathOverride;
  if (!session.outputPath) return null;
  const automatic = outputPathFor(video, workflow, naming);
  return session.outputPath.toLowerCase() === automatic.toLowerCase() ? null : session.outputPath;
}
