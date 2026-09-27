// src/utils/queueOutputPath.ts - Where a queue item writes, and keeping two items off the same file.

import type { Filter, SegmentSelection } from '../electron.d';
import { generateOutputSuffix } from './generateOutputSuffix';

export interface OutputNamingWorkflow {
  colorimetry?: any;
  filters: Filter[];
  segment?: SegmentSelection;
  outputFormat: string;
}

/** The output path the queue picks for a video when the user chose none. */
export function autoOutputPath(videoPath: string, workflow: OutputNamingWorkflow, descriptive: boolean): string {
  const suffix = descriptive
    ? generateOutputSuffix({ colorimetry: workflow.colorimetry, filters: workflow.filters, segment: workflow.segment })
    : 'processed';
  return videoPath.replace(/\.[^/.]+$/, '') + `-${suffix}.${workflow.outputFormat}`;
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
