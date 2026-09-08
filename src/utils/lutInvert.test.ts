// Running a known transform backwards, and — the part that matters — saying
// so when it cannot be run backwards at all. A grade that clipped destroyed
// information, and an inverse that pretended otherwise would hand back a table
// claiming to restore a picture it can only guess at.

import { describe, it, expect } from 'vitest';
import { invertOperations } from './lutInvert';
import { sampleLut, identityLut } from './lut';
import { GRADE_NEUTRAL, gradePixel, type GradeValues } from './colorGrade';

const op = (values: GradeValues) => ({ apply: (rgb: readonly [number, number, number]) => gradePixel(rgb, values) });

/**
 * What a round trip is allowed to cost.
 *
 * Two errors stack. The inverse solves each cell to within half a code value,
 * and then reading it back interpolates between cells — which lut.test.ts
 * measures at nearly 3 code values for a 33-cube on its own. Four is that,
 * with room for the curvature of a strong grade between two cells and nothing
 * more; a genuine inversion bug lands far outside it.
 */
const ROUND_TRIP_BUDGET = 4 / 255;

/** Colours to probe with, kept off the ends where a grade starts clipping. */
const PROBES = [
  [0.25, 0.4, 0.6],
  [0.5, 0.5, 0.5],
  [0.7, 0.35, 0.2],
  [0.15, 0.55, 0.45],
  [0.62, 0.62, 0.3],
] as const;

describe('inverting a composed transform', () => {
  it('takes a graded colour back to the one that produced it', () => {
    const look: GradeValues = { ...GRADE_NEUTRAL, contrast: 1.25, brightness: 0.04, saturation: 0.85 };
    const inverse = invertOperations([op(look)], 33);

    for (const probe of PROBES) {
      const graded = gradePixel(probe, look);
      sampleLut(inverse.lut, graded).forEach((got, i) =>
        expect(Math.abs(got - probe[i])).toBeLessThan(ROUND_TRIP_BUDGET));
    }
  });

  it('inverts a grade that mixes channels, not just one that scales them', () => {
    // Temperature and saturation both read all three channels to write one, so
    // the Jacobian is not diagonal here. A solver that assumed it was would
    // pass the test above and fail this one.
    const look: GradeValues = { ...GRADE_NEUTRAL, temperature: 1400, tint: -600, saturation: 0.7 };
    const inverse = invertOperations([op(look)], 33);

    for (const probe of PROBES) {
      const graded = gradePixel(probe, look);
      sampleLut(inverse.lut, graded).forEach((got, i) =>
        expect(Math.abs(got - probe[i])).toBeLessThan(ROUND_TRIP_BUDGET));
    }
  });

  it('undoes a whole stack at once, in the right order', () => {
    const first: GradeValues = { ...GRADE_NEUTRAL, lift: { r: 0, g: 0, b: 0, m: 0.08 } };
    const second: GradeValues = { ...GRADE_NEUTRAL, contrast: 1.3, saturation: 0.75 };
    const inverse = invertOperations([op(first), op(second)], 33);

    for (const probe of PROBES) {
      const through = gradePixel(gradePixel(probe, first), second);
      sampleLut(inverse.lut, through).forEach((got, i) =>
        expect(Math.abs(got - probe[i])).toBeLessThan(ROUND_TRIP_BUDGET));
    }
  });

  it('is an identity when nothing sits between the pair', () => {
    const inverse = invertOperations([], 17);
    const identity = identityLut(17);

    expect(inverse.unreachable).toBe(0);
    expect(inverse.lut.data).toEqual(identity.data);
  });

  it('measures how much of the range a grade pinned against white', () => {
    // Gain this hard drives everything above 0.385 to white, so most of the
    // input cube arrives with at least one channel stuck there and no table
    // can say which colour it came from.
    const blown: GradeValues = { ...GRADE_NEUTRAL, gain: { r: 1, g: 1, b: 1, m: 2.6 } };
    const inverse = invertOperations([op(blown)], 17);

    expect(inverse.clippedInput).toBeGreaterThan(0.9);
    // Every output colour is still produced by *something*, so nothing is out
    // of reach. Clipping and unreachability are different failures, and this
    // is the one that is purely clipping.
    expect(inverse.unreachableFraction).toBeLessThan(0.01);
  });

  it('does not call a desaturating grade clipped', () => {
    // Saturation leaves a third of the cube with no preimage — the vivid
    // corners — but pins nothing, so nothing has been destroyed. Reporting
    // that as clipping would send someone looking for a problem they do not
    // have.
    const flat: GradeValues = { ...GRADE_NEUTRAL, saturation: 0.7 };
    const inverse = invertOperations([op(flat)], 17);

    expect(inverse.clippedInput).toBeLessThan(0.01);
    expect(inverse.unreachableFraction).toBeGreaterThan(0.1);
  });

  it('leaves nothing unreachable for a grade that is onto the whole cube', () => {
    // Contrast clips at both ends but every output colour is still produced,
    // so a solver that walks into a plateau and gives up shows here and
    // nowhere else: a shell of cells at the bottom of the range, each one
    // attempted from the one place it could not move away from.
    for (const look of [
      { ...GRADE_NEUTRAL, contrast: 1.25 },
      { ...GRADE_NEUTRAL, gain: { r: 1, g: 1, b: 1, m: 2.6 }, contrast: 1.6 },
    ] as GradeValues[]) {
      expect(invertOperations([op(look)], 33).unreachable).toBe(0);
    }
  });

  it('keeps the cells it did solve within the tolerance it claims', () => {
    const look: GradeValues = { ...GRADE_NEUTRAL, gamma: { r: 1, g: 1, b: 1, m: 0.8 }, saturation: 1.2 };
    const inverse = invertOperations([op(look)], 33);
    expect(inverse.maxResidual).toBeLessThanOrEqual(0.5 / 255);
  });

  it('refuses a size no table format can hold', () => {
    expect(() => invertOperations([], 1)).toThrow(/not a usable cube size/);
    expect(() => invertOperations([], 4.5)).toThrow(/not a usable cube size/);
    expect(() => invertOperations([], 300)).toThrow(/not a usable cube size/);
  });
});
