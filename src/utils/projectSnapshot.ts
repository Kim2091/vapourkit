// src/utils/projectSnapshot.ts - The project as it was when the queue opened, kept to put back when it closes.

import type { BackendId, SegmentSelection } from '../electron.d';
import { outputPathFor, type OutputNaming, type OutputNamingVideo } from './queueOutputPath';

/** The localStorage form, read by older versions too. */
export type PreQueueWorkflow = {
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

/**
 * The output path the user chose for the snapshot's video, or null when it was
 * named automatically. Snapshots written before the choice was kept carry only
 * the path shown, which counts as chosen when it is not the automatic name.
 */
export function projectOutputOverride(
  snapshot: PreQueueWorkflow,
  video: OutputNamingVideo,
  naming: OutputNaming,
): string | null {
  if (snapshot.outputPathOverride !== undefined) return snapshot.outputPathOverride;
  if (!snapshot.outputPath) return null;
  const automatic = outputPathFor(video, snapshot, naming);
  return snapshot.outputPath.toLowerCase() === automatic.toLowerCase() ? null : snapshot.outputPath;
}
