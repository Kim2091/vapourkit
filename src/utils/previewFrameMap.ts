// src/utils/previewFrameMap.ts — one timeline, many clip lengths.
//
// The scrubber counts source frames, but a step is free to change how many
// frames there are: a bob deinterlacer doubles them, an IVTC drops them,
// frame generation multiplies them. Handing a source frame number straight to
// such an output asks it for the wrong moment — on a deinterlaced NTSC DVD
// the far right of the timeline (frame 43640 of 43640) is the *middle* of an
// output that has 87280 frames, so the timeline appeared to stop halfway
// through the episode.
//
// Output 0 is the untouched source, so it is the ruler every other output is
// measured against.

import type { PreviewOutput } from '../electron.d';

/**
 * Convert a source-space frame number into an index in `index`'s own clip.
 *
 * Scaled by frame count rather than by fps: the two agree wherever the rate
 * changed, and frame count is also right for steps that drop or add frames
 * without touching the rate.
 */
export function toOutputFrame(
  outputs: PreviewOutput[],
  index: number,
  sourceFrame: number,
): number {
  const target = outputs.find(output => output.index === index);
  if (!target || target.frames <= 0) return Math.max(0, Math.round(sourceFrame));

  const base = outputs.find(output => output.index === 0) ?? outputs[0];
  const scaled = base && base.frames > 0 && base.frames !== target.frames
    ? Math.round(sourceFrame * (target.frames / base.frames))
    : Math.round(sourceFrame);

  return Math.min(target.frames - 1, Math.max(0, scaled));
}
