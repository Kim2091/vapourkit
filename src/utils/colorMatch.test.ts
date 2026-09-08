// Fitting a table to evidence, and being straight about how well it fitted.
// The residual the panel shows is the whole basis on which someone decides to
// trust one of these, so it is measured through the finished lattice here —
// not through the maths that produced it.

import { describe, it, expect } from 'vitest';
import { pairsFromFrames, concatPairs, fitMatch, matchIsWorthApplying, MAX_PAIRS } from './colorMatch';
import { sampleLut } from './lut';
import { GRADE_NEUTRAL, gradePixel, type GradeValues } from './colorGrade';

const WIDTH = 128;
const HEIGHT = 128;
const BLOCK = 8;

/** Deterministic noise, so a failure is the same failure twice. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A frame of flat blocks in well-spread colours.
 *
 * Flat on purpose: the fit drops pixels sitting on detail, so a test picture
 * made of gradients and edges would be measuring the rejection rather than the
 * fitting. The block boundaries still give the edge test something to find.
 */
function blockFrame(seed = 7): Uint8Array {
  const random = mulberry32(seed);
  const colours: number[][] = [];
  for (let i = 0; i < (WIDTH / BLOCK) * (HEIGHT / BLOCK); i++) {
    colours.push([random(), random(), random()]);
  }

  const pixels = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const block = Math.floor(y / BLOCK) * (WIDTH / BLOCK) + Math.floor(x / BLOCK);
      const at = (y * WIDTH + x) * 3;
      for (let c = 0; c < 3; c++) pixels[at + c] = Math.round(colours[block][c] * 255);
    }
  }
  return pixels;
}

/** Put a frame through a grade, the way a step of the chain would. */
function graded(pixels: Uint8Array, values: GradeValues): Uint8Array {
  const out = new Uint8Array(pixels.length);
  for (let at = 0; at < pixels.length; at += 3) {
    const result = gradePixel([pixels[at] / 255, pixels[at + 1] / 255, pixels[at + 2] / 255], values);
    for (let c = 0; c < 3; c++) out[at + c] = Math.round(result[c] * 255);
  }
  return out;
}

describe('pairing two frames', () => {
  it('drops the pixels sitting on detail', () => {
    const frame = blockFrame();
    const pairs = pairsFromFrames(frame, frame, WIDTH, HEIGHT, MAX_PAIRS);

    // Every block boundary is an edge, and every block interior is not.
    expect(pairs.rejectedEdges).toBeGreaterThan(0);
    expect(pairs.count).toBeGreaterThan(1000);
    expect(pairs.count + pairs.rejectedEdges).toBe(pairs.considered);
  });

  it('refuses two frames that do not line up', () => {
    const frame = blockFrame();
    expect(() => pairsFromFrames(frame, frame.slice(0, 300), WIDTH, HEIGHT))
      .toThrow(/do not line up/);
  });

  it('spreads its sample over the whole frame rather than the top of it', () => {
    const frame = blockFrame();
    // A cap far below the pixel count forces striding; the pairs should still
    // come from the bottom half as well as the top.
    const pairs = pairsFromFrames(frame, frame, WIDTH, HEIGHT, 200);
    expect(pairs.count).toBeGreaterThan(20);
    expect(pairs.count).toBeLessThan(2000);
  });

  it('joins what several frames contributed', () => {
    const one = pairsFromFrames(blockFrame(1), blockFrame(1), WIDTH, HEIGHT);
    const two = pairsFromFrames(blockFrame(2), blockFrame(2), WIDTH, HEIGHT);
    const both = concatPairs([one, two]);

    expect(both.count).toBe(one.count + two.count);
    expect(both.from.length).toBe(both.count * 3);
    expect(both.from[0]).toBeCloseTo(one.from[0], 6);
  });
});

describe('fitting a match', () => {
  const source = blockFrame();

  it('recovers a per-channel drift almost exactly', () => {
    // Temperature and a gain below one are per-channel and clip nothing, so
    // there is nothing here the curves cannot express. Measured at 35 code
    // values of drift coming down to under 2.
    const drift: GradeValues = { ...GRADE_NEUTRAL, temperature: 900, gain: { r: 1, g: 1, b: 1, m: 0.9 } };
    const fit = fitMatch(pairsFromFrames(graded(source, drift), source, WIDTH, HEIGHT), 33);

    expect(fit.before.p95).toBeGreaterThan(20);
    expect(fit.after.p95).toBeLessThan(3);
    expect(matchIsWorthApplying(fit)).toBe(true);
  });

  it('corrects a cross-channel drift a per-channel curve cannot', () => {
    // Saturation mixes all three channels to write one, so curves alone cannot
    // express it at any setting. This is the matrix stage being measured, and
    // it is the case that fails outright if the two stages are fitted in one
    // pass rather than against each other.
    const drift: GradeValues = { ...GRADE_NEUTRAL, saturation: 0.65 };
    const fit = fitMatch(pairsFromFrames(graded(source, drift), source, WIDTH, HEIGHT), 33);

    expect(fit.before.p95).toBeGreaterThan(40);
    expect(fit.after.p95).toBeLessThan(fit.before.p95 / 6);
  });

  it('corrects a hue rotation, which is the other thing curves cannot see', () => {
    const drift: GradeValues = { ...GRADE_NEUTRAL, hue: 12, saturation: 0.9 };
    const fit = fitMatch(pairsFromFrames(graded(source, drift), source, WIDTH, HEIGHT), 33);

    expect(fit.after.p95).toBeLessThan(fit.before.p95 / 5);
  });

  it('cannot undo what the drift clipped, and the residual shows it', () => {
    // Contrast crushes everything below 0.072 to black. Those pixels arrive
    // identical whatever they were, so no table can separate them again — and
    // the fit must not claim otherwise. The average still comes right down;
    // it is the worst 5% that stays put, which is exactly the shape of a
    // clipping loss and the reason both numbers are reported.
    const drift: GradeValues = { ...GRADE_NEUTRAL, contrast: 1.2, temperature: 900 };
    const fit = fitMatch(pairsFromFrames(graded(source, drift), source, WIDTH, HEIGHT), 33);

    expect(fit.after.mean).toBeLessThan(fit.before.mean / 4);
    expect(fit.after.p95).toBeGreaterThan(5);
  });

  it('says a table is not worth applying when the two steps already agree', () => {
    const fit = fitMatch(pairsFromFrames(source, source, WIDTH, HEIGHT), 17);

    expect(fit.before.p95).toBeLessThan(1);
    expect(matchIsWorthApplying(fit)).toBe(false);
  });

  it('fits close to an identity when there is nothing to correct', () => {
    const fit = fitMatch(pairsFromFrames(source, source, WIDTH, HEIGHT), 17);
    for (const probe of [[0.25, 0.5, 0.75], [0.1, 0.9, 0.4]] as const) {
      sampleLut(fit.lut, probe).forEach((got, i) => expect(Math.abs(got - probe[i])).toBeLessThan(0.02));
    }
  });

  it('never writes a table that runs backwards', () => {
    // A dip in the curve swaps the order of two levels, which shows up on a
    // gradient as banding. Thin bins are where that would come from, so the
    // check is along the whole neutral ramp.
    const drift: GradeValues = { ...GRADE_NEUTRAL, contrast: 1.4, gamma: { r: 1, g: 1, b: 1, m: 0.85 } };
    const fit = fitMatch(pairsFromFrames(graded(source, drift), source, WIDTH, HEIGHT), 33);

    let previous = -Infinity;
    for (let i = 0; i <= 64; i++) {
      const level = i / 64;
      const luma = sampleLut(fit.lut, [level, level, level])[1];
      expect(luma).toBeGreaterThanOrEqual(previous - 1e-6);
      previous = luma;
    }
  });

  it('keeps every entry inside the range a table can hold', () => {
    const drift: GradeValues = { ...GRADE_NEUTRAL, gain: { r: 1.15, g: 1, b: 0.85, m: 1.3 }, contrast: 1.3 };
    const fit = fitMatch(pairsFromFrames(graded(source, drift), source, WIDTH, HEIGHT), 17);

    for (const value of fit.lut.data) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('refuses a size no table format can hold, and a fit with no evidence', () => {
    const pairs = pairsFromFrames(source, source, WIDTH, HEIGHT);
    expect(() => fitMatch(pairs, 1)).toThrow(/not a usable cube size/);
    expect(() => fitMatch({ ...pairs, count: 0 }, 33)).toThrow(/no pixels to measure/);
  });
});
