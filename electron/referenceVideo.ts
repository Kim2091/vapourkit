// electron/referenceVideo.ts — a stage reference that names a video file
// instead of a step.
//
// A step that reads another picture holds one value: the id of the step it
// reads from, or '' for the source. Matching colour against a different
// release of the same footage (a DVD for an HD master, a broadcast for a
// remaster) needs a picture from outside the chain altogether, so the same
// value can instead name a file, with the frame offset that lines it up.
//
// One value rather than a second variable, so the choice cannot be half
// made: a file path left behind beside a step id would leave the script and
// the card disagreeing about which one counts. Workflow import remaps only
// values that are exactly a step id, which this never is.
//
// Pure, so the renderer's card and the generator read it the same way.

export const REFERENCE_VIDEO_PREFIX = 'file:';

export interface ReferenceVideo {
  path: string;
  /**
   * The reference frame that lines up with the source's first frame. Positive
   * when the reference has extra frames at the start, negative when it is
   * missing some.
   */
  offset: number;
}

export function encodeReferenceVideo(reference: ReferenceVideo): string {
  return REFERENCE_VIDEO_PREFIX + JSON.stringify({
    path: reference.path,
    offset: Math.trunc(reference.offset) || 0,
  });
}

/** The file a stage reference names, or null when it names a step or the source. */
export function parseReferenceVideo(value: unknown): ReferenceVideo | null {
  if (typeof value !== 'string' || !value.startsWith(REFERENCE_VIDEO_PREFIX)) return null;
  try {
    const parsed = JSON.parse(value.slice(REFERENCE_VIDEO_PREFIX.length));
    if (!parsed || typeof parsed.path !== 'string' || !parsed.path) return null;
    const offset = Number(parsed.offset);
    return { path: parsed.path, offset: Number.isFinite(offset) ? Math.trunc(offset) : 0 };
  } catch {
    return null;
  }
}

/** The file's name without its folder, for a label. */
export function referenceVideoName(reference: ReferenceVideo): string {
  return reference.path.split(/[\\/]/).pop() || reference.path;
}
