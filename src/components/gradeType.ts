// src/components/gradeType.ts — the grading panel's type, stated once.
//
// Everything in the dock, the trackballs and the scope column was drawn at
// absolute px — 9px section labels, 9px readouts, 10.5px tone names — which
// pinned the panel's type at one size no matter how big the window it sat in
// got, and pinned it small. It reads as a different, denser application than
// the 11-13px the rest of Vapourkit uses.
//
// So the sizes below are em, resolved against a base the dock picks from the
// room it has, and set on the dock and column roots. One number moves and the
// whole panel moves with it, labels and numbers and the widths computed from
// them together.

/** Sizes relative to the base. Raising the base raises all of them. */
export const GRADE_TYPE = {
  /** PRIMARIES, TONE, SCOPES — the block headings. */
  section: '0.83em',
  /** COLOR WHEELS, and the column's own heading. */
  title: '1.08em',
  /** Ball names and tone names: the things you read to find a control. */
  label: '0.92em',
  /** shadows / midtones / highlights, under a ball name. */
  hint: '0.79em',
  /** Numbers you read a value back from. */
  value: '0.83em',
  /** Buttons inside the panel. */
  button: '0.88em',
} as const;

/** The base, in px, for a dock of this width. The floor is 13, not the 9 the
    panel started at: the rest of Vapourkit runs 12.5-13px, and the grading
    panel reading smaller than everything around it is the "default is quite
    small" part. Above the floor it takes what the room allows. */
export function gradeBasePx(width: number, compact: boolean): number {
  if (!compact && width >= 1600) return 15;
  if (!compact || width >= 1400) return 14;
  return 13;
}

/** A monospace character is about a third of its font size wide, and a
    readout holds five of them ("1.000", "-.120"), plus room not to touch its
    neighbour. Everything that reserves space for a number uses this. */
export function readoutCellWidth(basePx: number): number {
  return Math.ceil(basePx * Number(GRADE_TYPE.value.replace('em', '')) * 3.2);
}
