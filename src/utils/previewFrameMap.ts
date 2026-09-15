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

/**
 * The inverse: a frame of `index`'s clip, back in source space.
 *
 * Returned unrounded. Playback walks the timeline through this on every
 * presented frame, and rounding here would let a 2x step's odd frames floor
 * onto the same source frame twice — the playhead would advance in stutters
 * and a step switch would lose up to a frame each time. Callers round only
 * when they need an integer.
 */
export function toSourceFrame(
  outputs: PreviewOutput[],
  index: number,
  outputFrame: number,
): number {
  const target = outputs.find(output => output.index === index);
  if (!target || target.frames <= 0) return Math.max(0, outputFrame);

  const base = outputs.find(output => output.index === 0) ?? outputs[0];
  if (!base || base.frames <= 0 || base.frames === target.frames) {
    return Math.max(0, outputFrame);
  }
  return Math.max(0, outputFrame * (base.frames / target.frames));
}

/**
 * The rate to play `index` at.
 *
 * Its own fps when the clip reports one. A variable-rate node reports 0/1, and
 * there the honest estimate is the source rate scaled by how many frames this
 * output has: a step that doubled the frames doubled the rate.
 */
export function outputFps(
  outputs: PreviewOutput[],
  index: number,
  sourceFps: number,
): number {
  const target = outputs.find(output => output.index === index);
  if (!target) return sourceFps;

  if (target.fpsNum > 0 && target.fpsDen > 0) return target.fpsNum / target.fpsDen;

  const base = outputs.find(output => output.index === 0) ?? outputs[0];
  if (!base || base.frames <= 0 || target.frames <= 0) return sourceFps;
  return sourceFps * (target.frames / base.frames);
}
