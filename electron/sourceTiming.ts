// electron/sourceTiming.ts

/**
 * Where a generated script's BestSource writes the source's timecodes (v2,
 * one frame start time in milliseconds per line), beside the script.
 */
export function timecodesPathFor(scriptPath: string): string {
  return scriptPath.replace(/\.vpy$/i, '') + '.timecodes.txt';
}

/**
 * Frame start times in seconds from the text of a timecodes v2 file (a
 * comment header, then one start time in milliseconds per frame). The list is
 * empty when the text holds none, or when any line is not a number.
 */
export function parseTimecodesV2(text: string): number[] {
  const times: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const ms = Number(line);
    if (!Number.isFinite(ms)) return [];
    times.push(ms / 1000);
  }
  return times;
}

export interface TimingSegment {
  enabled: boolean;
  startFrame: number;
  /** Exclusive; -1 means the end of the video. */
  endFrame: number;
}

/** Where the copied audio and subtitles start (input -ss) and how long they run (input -t), in seconds. */
export interface AudioTrim {
  start: number | null;
  duration: number | null;
  /** True when the times come from the source's own frame timestamps. */
  exact: boolean;
}

/** Offsets smaller than this are left alone; one audio sample at 48 kHz is about 0.02 ms. */
const MIN_OFFSET = 0.0005;

/**
 * The trim that lines the source's audio and subtitles up with the output
 * video, which starts at the first output frame and lasts until the frame
 * after the last.
 *
 * `frameTimes` are the source's frame start times as its container states
 * them. `formatStart` is the file's start time (ffmpeg's "start:"), the
 * earliest of its streams, which an input -ss counts from; a video that
 * starts after its audio needs the audio cut by the difference even in a full
 * run. Without frame times the trim falls back to frame / `fallbackFps`,
 * which is exact only for a constant frame rate.
 */
export function audioTrimFor(
  frameTimes: number[],
  formatStart: number | null,
  segment?: TimingSegment,
  fallbackFps?: number,
): AudioTrim {
  const useSegment = !!segment?.enabled;
  if (frameTimes.length > 0) {
    const first = useSegment ? Math.min(Math.max(segment!.startFrame, 0), frameTimes.length - 1) : 0;
    const startTime = frameTimes[first];
    const offset = startTime - (formatStart ?? 0);
    const end = useSegment && segment!.endFrame > 0 && segment!.endFrame < frameTimes.length
      ? frameTimes[segment!.endFrame]
      : null;
    return {
      start: offset >= MIN_OFFSET ? offset : null,
      duration: end !== null ? end - startTime : null,
      exact: true,
    };
  }
  if (useSegment && fallbackFps && fallbackFps > 0) {
    const start = segment!.startFrame / fallbackFps;
    const duration = segment!.endFrame > 0 ? (segment!.endFrame - segment!.startFrame) / fallbackFps : null;
    return { start, duration, exact: false };
  }
  return { start: null, duration: null, exact: false };
}

/**
 * The time base, as ticks per second, the encoder and an MP4/MOV track use
 * for the output video. A constant n/d rate gets a multiple of n of at least
 * 10000, as ffmpeg itself would choose, on which every frame lands exactly.
 * A variable rate, or a constant one whose numerator is too large for that,
 * gets microseconds, the resolution vspipe writes its timestamps in.
 */
export function videoTimescaleFor(fpsString: string | null, variableFrameRate: boolean): number {
  const MICROSECONDS = 1000000;
  const match = fpsString?.match(/^(\d+)\/(\d+)$/);
  if (variableFrameRate || !match) return MICROSECONDS;
  let timescale = parseInt(match[1], 10);
  if (timescale <= 0 || timescale > MICROSECONDS) return MICROSECONDS;
  while (timescale < 10000) timescale *= 2;
  return timescale;
}
