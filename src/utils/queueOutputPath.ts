// src/utils/queueOutputPath.ts - Where a render writes, and keeping two queue items off the same file.

import type { ColorimetrySettings, Filter, QueueItem, SegmentSelection } from '../electron.d';
import { generateOutputSuffix } from './generateOutputSuffix';

export interface OutputNamingWorkflow {
  colorimetry?: ColorimetrySettings;
  filters: Filter[];
  segment?: SegmentSelection;
  outputFormat: string;
}

/** The settings that decide where an automatically named output goes. */
export interface OutputNaming {
  defaultOutputFolder: string | null;
  descriptive: boolean;
}

/** The facts about a video that its output name can mention. */
export interface OutputNamingVideo {
  path: string;
  resolution?: string | null;
  outputResolution?: string | null;
  fps?: string | number | null;
  outputFps?: string | number | null;
}

/** A queue item as the queue file stores it. */
export type QueueEntry = QueueItem & {
  /** The user chose this output path, so edits to the item leave it alone. Absent on older items. */
  customOutputPath?: boolean;
};

const EXTENSION = /\.[^/.\\]+$/;

function stripExtension(path: string): string {
  return path.replace(EXTENSION, '');
}

/** path with its extension replaced by format's, or format's added when it has none. */
export function withExtension(path: string, format: string): string {
  return `${stripExtension(path)}.${format}`;
}

/**
 * Where a render of video with workflow writes when the user has not chosen a
 * path: beside the source, or in the default output folder, named from the
 * chain when descriptive naming is on.
 */
export function outputPathFor(
  video: OutputNamingVideo | string,
  workflow: OutputNamingWorkflow,
  naming: OutputNaming,
): string {
  const source = typeof video === 'string' ? { path: video } : video;
  const suffix = naming.descriptive
    ? generateOutputSuffix(
        { colorimetry: workflow.colorimetry, filters: workflow.filters, segment: workflow.segment },
        {
          inputResolution: source.resolution,
          outputResolution: source.outputResolution,
          inputFps: source.fps,
          outputFps: source.outputFps,
        },
      )
    : 'processed';

  const folder = naming.defaultOutputFolder?.replace(/[\\/]+$/, '');
  if (folder) {
    const separator = folder.includes('\\') ? '\\' : '/';
    const fileName = stripExtension(source.path.split(/[\\/]/).pop() || '') || 'output';
    return `${folder}${separator}${fileName}-${suffix}.${workflow.outputFormat}`;
  }
  return `${stripExtension(source.path)}-${suffix}.${workflow.outputFormat}`;
}

/**
 * `outputPath`, or `name-2.ext`, `name-3.ext`, ... - the first one no other
 * queue item writes to. Compared case-insensitively, as Windows paths are.
 */
export function uniqueOutputPath(outputPath: string, taken: Iterable<string>): string {
  const used = new Set(Array.from(taken, p => p.toLowerCase()));
  if (!used.has(outputPath.toLowerCase())) return outputPath;
  const match = outputPath.match(/^(.*?)(\.[^/.\\]+)?$/);
  const stem = match?.[1] ?? outputPath;
  const ext = match?.[2] ?? '';
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether the item's output path was named automatically, so it follows edits
 * to the item. Items without the flag are recognised by their name: the one
 * outputPathFor gives them, with or without the default output folder, or
 * that name numbered by uniqueOutputPath.
 */
export function isAutoOutputPath(item: QueueEntry, naming: OutputNaming): boolean {
  if (item.customOutputPath !== undefined) return !item.customOutputPath;
  const folders = naming.defaultOutputFolder ? [naming.defaultOutputFolder, null] : [null];
  return folders.some(defaultOutputFolder => {
    const expected = outputPathFor(item.videoPath, item.workflow, { ...naming, defaultOutputFolder });
    const match = expected.match(/^(.*?)(\.[^/.\\]+)?$/);
    const stem = escapeRegExp(match?.[1] ?? expected);
    const ext = escapeRegExp(match?.[2] ?? '');
    return new RegExp(`^${stem}(-\\d+)?${ext}$`, 'i').test(item.outputPath);
  });
}

/**
 * queue with itemId's workflow updated. A pending item only: one that has
 * started or finished was encoded with the settings it had then. An
 * automatically named output follows the edit and stays off every other
 * item's file; a path the user chose only takes a new output format's
 * extension.
 */
export function withItemWorkflow(
  queue: QueueEntry[],
  itemId: string,
  workflow: Partial<QueueItem['workflow']>,
  naming: OutputNaming,
): QueueEntry[] {
  return queue.map(item => {
    if (item.id !== itemId || item.status !== 'pending') return item;
    const merged = { ...item.workflow, ...workflow };
    if (!isAutoOutputPath(item, naming)) {
      // A chosen path keeps up with the output format, as the window's does.
      const outputPath = merged.outputFormat !== item.workflow.outputFormat
        ? withExtension(item.outputPath, merged.outputFormat)
        : item.outputPath;
      return { ...item, outputPath, workflow: merged };
    }
    const outputPath = uniqueOutputPath(
      outputPathFor(item.videoPath, merged, naming),
      queue.filter(other => other.id !== itemId).map(other => other.outputPath),
    );
    return { ...item, outputPath, customOutputPath: false, workflow: merged };
  });
}

/**
 * New pending items for videoPaths with workflow, skipping any video already
 * waiting or running. output is the path the window shows, for a single
 * video. A path named automatically, given or not, is kept clear of the files
 * other items write; one the user chose is kept as it is.
 */
export function newQueueItems(
  queue: QueueEntry[],
  videoPaths: string[],
  workflow: QueueItem['workflow'],
  naming: OutputNaming,
  output?: { path: string; custom: boolean },
): { items: QueueEntry[]; skipped: number } {
  const active = new Set(
    queue
      .filter(item => item.status === 'pending' || item.status === 'processing')
      .map(item => item.videoPath.toLowerCase()),
  );
  const paths = videoPaths.filter(path => !active.has(path.toLowerCase()));
  const taken = queue.map(item => item.outputPath);
  const settled = output && paths.length === 1 ? output : null;
  const items = paths.map((videoPath, index): QueueEntry => {
    const outputPath = settled?.custom
      ? settled.path
      : uniqueOutputPath(settled?.path ?? outputPathFor(videoPath, workflow, naming), taken);
    taken.push(outputPath);
    return {
      id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 11)}`,
      videoPath,
      videoName: videoPath.split(/[\\/]/).pop() || 'unknown',
      outputPath,
      customOutputPath: settled?.custom ?? false,
      status: 'pending',
      addedAt: new Date().toISOString(),
      workflow: {
        ...workflow,
        filters: structuredClone(workflow.filters),
        segment: workflow.segment ? { ...workflow.segment } : undefined,
      },
    };
  });
  return { items, skipped: videoPaths.length - paths.length };
}
