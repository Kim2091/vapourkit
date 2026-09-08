// src/utils/colorMatch.ts — the transform between two steps, measured.
//
// lutInvert composes a transform it knows and runs it backwards. This is for
// the case where there is nothing to compose: a neural upscaler sits between
// the two steps, and neither Vapourkit nor the model itself can say what it
// does to colour. There is no function to invert, only evidence — the same
// frames, as the two steps render them — so the table is fitted to that.
//
// What gets fitted is deliberately smooth and deliberately small:
//
//   one 3x3 matrix, for the cross-channel part — saturation and hue rotation,
//   which a per-channel curve structurally cannot express at all; then
//
//   a per-channel curve on what that leaves, which is where level shifts,
//   gamma drift and a colour cast live.
//
// That order is not arbitrary. A grade applies its per-channel work first and
// its saturation last, so undoing one runs the other way round: the matrix has
// to come off before the curves can see a clean per-channel relationship.
// Fitted curves-first, a pure saturation change comes back only a third
// corrected, because the curve stage makes a poor guess at a cross-channel
// effect and the matrix afterwards cannot unpick it.
//
// A full 3D lattice fit would express more and is the obvious next step, but
// it would also invent a mapping for every colour the sampled frames never
// contained. Two smooth stages have no holes anywhere, which matters because
// the table is going to be applied to a whole film and fitted from five
// frames of it. If the residuals say these two are leaving something behind,
// that is the moment to add the third — not before.
//
// Everything here works in the same plain 0..1 RGB the preview serves and the
// Apply LUT filter operates in, so the table that comes out is measured in the
// space it will be used in.

import { lutIndex, sampleLut, type Lut } from './lut';

/** Pixels seen at both steps: the colour that is there, and the one wanted. */
export interface ColorPairs {
  /** Interleaved RGB in 0..1, as the step being corrected renders it. */
  from: Float32Array;
  /** The same pixels, as the step being matched to renders them. */
  to: Float32Array;
  count: number;
  /** How many pixels were looked at before edges and subsampling. */
  considered: number;
  /** How many were dropped for sitting on detail rather than on colour. */
  rejectedEdges: number;
}

export interface ResidualSummary {
  /** Average difference across pixels, in 8-bit code values. */
  mean: number;
  /** The difference 95% of pixels come in under, in 8-bit code values. */
  p95: number;
}

export interface MatchFit {
  lut: Lut;
  pairs: number;
  /** How far apart the two steps were to begin with. */
  before: ResidualSummary;
  /** How far apart they are once the table is applied. */
  after: ResidualSummary;
}

/** Bins along each channel for the curve. 64 is finer than any real drift. */
const CURVE_BINS = 64;

/**
 * Local contrast above which a pixel is dropped from the fit.
 *
 * Six code values. A model's output differs from its input most where the
 * detail is — that is what the model is for — and those pixels say nothing
 * useful about colour while dragging the fit around. Flat regions are the
 * evidence; edges are the noise.
 */
const EDGE_LIMIT = 6 / 255;

/** Pairs to fit from. Beyond this the numbers stop moving and the wait grows. */
export const MAX_PAIRS = 200_000;

/** A bin holding fewer than this share of the pairs is treated as empty. */
const THIN_BIN = 0.0005;

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * Pull matching pixels out of two rendered frames.
 *
 * Both frames have to be the same size, which is what asking the session for
 * the same width at both outputs buys: a 2x model's picture and the source
 * arrive on the same grid, so pixel n is the same part of the picture in both.
 * A crop or an anamorphic resize between the two steps breaks that, and there
 * is no honest way to pair them — the caller checks before getting here.
 */
export function pairsFromFrames(
  fromPixels: Uint8Array,
  toPixels: Uint8Array,
  width: number,
  height: number,
  maxPairs: number = MAX_PAIRS,
): ColorPairs {
  const expected = width * height * 3;
  if (fromPixels.length < expected || toPixels.length < expected) {
    throw new Error('Those two frames are not the same size, so their pixels do not line up.');
  }

  // Luma of the corrected side, used only to find the edges to stay off.
  const luma = new Float32Array(width * height);
  for (let i = 0, at = 0; i < luma.length; i++, at += 3) {
    luma[i] = (0.2126 * fromPixels[at] + 0.7152 * fromPixels[at + 1] + 0.0722 * fromPixels[at + 2]) / 255;
  }

  const interior = Math.max(0, (width - 2) * (height - 2));
  // Every nth pixel rather than the first n, so the sample is spread over the
  // whole frame instead of over its top few rows.
  const stride = Math.max(1, Math.floor(interior / maxPairs));

  const from: number[] = [];
  const to: number[] = [];
  let considered = 0;
  let rejectedEdges = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const index = y * width + x;
      if ((index - 1) % stride !== 0) continue;
      considered++;

      const here = luma[index];
      const range = Math.max(
        Math.abs(luma[index - 1] - here),
        Math.abs(luma[index + 1] - here),
        Math.abs(luma[index - width] - here),
        Math.abs(luma[index + width] - here),
      );
      if (range > EDGE_LIMIT) { rejectedEdges++; continue; }

      const at = index * 3;
      from.push(fromPixels[at] / 255, fromPixels[at + 1] / 255, fromPixels[at + 2] / 255);
      to.push(toPixels[at] / 255, toPixels[at + 1] / 255, toPixels[at + 2] / 255);
    }
  }

  return {
    from: Float32Array.from(from),
    to: Float32Array.from(to),
    count: from.length / 3,
    considered,
    rejectedEdges,
  };
}

/** Join what several frames contributed into one set of pairs. */
export function concatPairs(parts: ColorPairs[]): ColorPairs {
  const count = parts.reduce((total, part) => total + part.count, 0);
  const from = new Float32Array(count * 3);
  const to = new Float32Array(count * 3);
  let at = 0;
  for (const part of parts) {
    from.set(part.from, at);
    to.set(part.to, at);
    at += part.count * 3;
  }
  return {
    from,
    to,
    count,
    considered: parts.reduce((total, part) => total + part.considered, 0),
    rejectedEdges: parts.reduce((total, part) => total + part.rejectedEdges, 0),
  };
}

/**
 * What each input level became, per channel.
 *
 * Binned conditional means rather than histogram matching. Both would work,
 * but the pixels here are *paired* — the same part of the same frame at two
 * steps — and a conditional mean uses that, where matching two sorted
 * histograms throws it away and would happily "correct" a difference in
 * content for a difference in colour.
 *
 * Forced non-decreasing afterwards. A curve that dips is a curve that inverts
 * the order of two levels, which reads as posterisation on a gradient, and a
 * dip in a fitted curve is always noise from a thin bin rather than a real
 * property of the transform.
 */
function toneCurves(pairs: ColorPairs, matrix: number[]): Float32Array[] {
  const curves: Float32Array[] = [];
  const minimumCount = Math.max(1, pairs.count * THIN_BIN);

  for (let channel = 0; channel < 3; channel++) {
    const sums = new Float64Array(CURVE_BINS);
    const counts = new Float64Array(CURVE_BINS);

    for (let i = 0; i < pairs.count; i++) {
      const at = i * 3;
      // Binned on what the matrix has already produced, not on the raw
      // colour: that is the input the curve will actually be handed.
      const level = matrix[channel * 3] * pairs.from[at]
        + matrix[channel * 3 + 1] * pairs.from[at + 1]
        + matrix[channel * 3 + 2] * pairs.from[at + 2];
      const bin = Math.round(clamp01(level) * (CURVE_BINS - 1));
      sums[bin] += pairs.to[at + channel];
      counts[bin]++;
    }

    const curve = new Float32Array(CURVE_BINS);
    const known = new Uint8Array(CURVE_BINS);
    for (let bin = 0; bin < CURVE_BINS; bin++) {
      if (counts[bin] < minimumCount) continue;
      curve[bin] = sums[bin] / counts[bin];
      known[bin] = 1;
    }

    // A frame that never contains a level says nothing about it. Rather than
    // invent a correction there, join across the gap and hold the end values
    // flat past the last thing actually seen — an identity would be a claim,
    // and this is an admission.
    let first = -1;
    let last = -1;
    for (let bin = 0; bin < CURVE_BINS; bin++) if (known[bin]) { if (first < 0) first = bin; last = bin; }
    if (first < 0) {
      // Nothing at all to go on: the identity is the only honest curve.
      for (let bin = 0; bin < CURVE_BINS; bin++) curve[bin] = bin / (CURVE_BINS - 1);
      curves.push(curve);
      continue;
    }
    for (let bin = 0; bin < first; bin++) curve[bin] = curve[first] - (first - bin) / (CURVE_BINS - 1);
    for (let bin = last + 1; bin < CURVE_BINS; bin++) curve[bin] = curve[last] + (bin - last) / (CURVE_BINS - 1);
    let previous = first;
    for (let bin = first + 1; bin <= last; bin++) {
      if (!known[bin]) continue;
      const span = bin - previous;
      for (let step = 1; step < span; step++) {
        curve[previous + step] = curve[previous] + (curve[bin] - curve[previous]) * (step / span);
      }
      previous = bin;
    }

    // Light smoothing, then monotone. In that order: smoothing a monotone
    // curve can reintroduce a dip, and this way the last word is the one that
    // matters.
    const smoothed = new Float32Array(CURVE_BINS);
    for (let bin = 0; bin < CURVE_BINS; bin++) {
      const low = curve[Math.max(0, bin - 1)];
      const high = curve[Math.min(CURVE_BINS - 1, bin + 1)];
      smoothed[bin] = (low + 2 * curve[bin] + high) / 4;
    }
    let ceiling = -Infinity;
    for (let bin = 0; bin < CURVE_BINS; bin++) {
      ceiling = Math.max(ceiling, smoothed[bin]);
      smoothed[bin] = ceiling;
    }

    curves.push(smoothed);
  }

  return curves;
}

/** Read a curve at an arbitrary level. */
function applyCurve(curve: Float32Array, value: number): number {
  const t = clamp01(value) * (CURVE_BINS - 1);
  const low = Math.floor(t);
  const high = Math.min(CURVE_BINS - 1, low + 1);
  return curve[low] + (curve[high] - curve[low]) * (t - low);
}

/**
 * Read a curve backwards: the level that would have produced this value.
 *
 * The curve is non-decreasing by construction, so this is a search rather than
 * an inversion. Where it runs flat — a range of levels that all became the
 * same value — the middle of that run is returned, which is the only answer
 * that does not favour one end of something the evidence cannot separate.
 */
function invertCurve(curve: Float32Array, value: number): number {
  if (value <= curve[0]) return 0;
  if (value >= curve[CURVE_BINS - 1]) return 1;

  let low = 0;
  let high = CURVE_BINS - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (curve[middle] <= value) low = middle;
    else high = middle;
  }
  const span = curve[high] - curve[low];
  const t = span > 1e-9 ? (value - curve[low]) / span : 0.5;
  return (low + t) / (CURVE_BINS - 1);
}

/**
 * The cross-channel part, as one 3x3 that leaves neutrals alone.
 *
 * Every row is made to sum to one, which is the whole reason this stage stays
 * in its lane. Grey in, the same grey out: the matrix cannot brighten, darken
 * or bend the range, so a level shift or a gamma drift has nowhere to hide in
 * it and falls to the curves, which is where it belongs and where it can be
 * expressed exactly. Without that constraint the two stages fight — the matrix
 * fits a nonlinear per-channel drift with the best straight line it can find,
 * and the curves then have to undo that before they can do their own work.
 * Measured on a per-channel drift, letting the matrix roam costs about two
 * code values of residual; measured on a saturation change, having no matrix
 * at all costs twenty.
 *
 * Solved by substituting the third weight away, so the constraint holds
 * exactly rather than approximately, and ridged towards the identity so a
 * scene where all three channels happen to move together — a night shot, say —
 * cannot be fitted by wild off-diagonal terms that fall apart on any other
 * frame.
 */
function crossMatrix(pairs: ColorPairs, curves: Float32Array[]): number[] {
  let saa = 0, sab = 0, sbb = 0;
  const sat = [0, 0, 0];
  const sbt = [0, 0, 0];

  for (let i = 0; i < pairs.count; i++) {
    const at = i * 3;
    // With the third weight written as 1 - m0 - m1, the fit is over how far
    // each of the other two channels sits from it.
    const a = pairs.from[at] - pairs.from[at + 2];
    const b = pairs.from[at + 1] - pairs.from[at + 2];
    saa += a * a;
    sab += a * b;
    sbb += b * b;
    for (let c = 0; c < 3; c++) {
      // Fitted against what the matrix is actually asked to produce: the
      // colour that, once the curve has been applied to it, lands on the
      // target. Fitting straight at the target instead makes the matrix
      // responsible for the curve's work as well, and the two stages spend
      // the fit undoing one another.
      const t = invertCurve(curves[c], pairs.to[at + c]) - pairs.from[at + 2];
      sat[c] += a * t;
      sbt[c] += b * t;
    }
  }

  const identity = [[1, 0], [0, 1], [0, 0]];
  const lambda = Math.max((saa + sbb) / 2, 1e-9) * 1e-3;

  const matrix: number[] = [];
  for (let c = 0; c < 3; c++) {
    const a11 = saa + lambda;
    const a12 = sab;
    const a22 = sbb + lambda;
    const b1 = sat[c] + lambda * identity[c][0];
    const b2 = sbt[c] + lambda * identity[c][1];

    const determinant = a11 * a22 - a12 * a12;
    if (!Number.isFinite(determinant) || Math.abs(determinant) <= 0) {
      matrix.push(c === 0 ? 1 : 0, c === 1 ? 1 : 0, c === 2 ? 1 : 0);
      continue;
    }
    const m0 = (b1 * a22 - b2 * a12) / determinant;
    const m1 = (a11 * b2 - a12 * b1) / determinant;
    if (!Number.isFinite(m0) || !Number.isFinite(m1)) {
      matrix.push(c === 0 ? 1 : 0, c === 1 ? 1 : 0, c === 2 ? 1 : 0);
      continue;
    }
    matrix.push(m0, m1, 1 - m0 - m1);
  }
  return matrix;
}

/** Difference between two pictures, summarised in 8-bit code values. */
function summarise(errors: Float32Array): ResidualSummary {
  if (errors.length === 0) return { mean: 0, p95: 0 };

  let total = 0;
  // A histogram rather than a sort: 200,000 values, and all that is wanted
  // from them is an average and a percentile.
  const BINS = 2048;
  const histogram = new Uint32Array(BINS + 1);
  for (const error of errors) {
    total += error;
    histogram[Math.min(BINS, Math.round(error * 8))]++;
  }

  const wanted = errors.length * 0.95;
  let seen = 0;
  let p95 = BINS;
  for (let bin = 0; bin <= BINS; bin++) {
    seen += histogram[bin];
    if (seen >= wanted) { p95 = bin; break; }
  }

  return { mean: total / errors.length, p95: p95 / 8 };
}

/** How far apart two sets of colours are, per pixel, in code values. */
function differences(a: Float32Array, b: Float32Array, count: number): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const at = i * 3;
    out[i] = Math.max(
      Math.abs(a[at] - b[at]),
      Math.abs(a[at + 1] - b[at + 1]),
      Math.abs(a[at + 2] - b[at + 2]),
    ) * 255;
  }
  return out;
}

/**
 * Fit a table that carries the colour at one step to the colour at another.
 *
 * The residuals come back measured through the finished lattice rather than
 * through the maths that produced it, so the number reported is the one the
 * exported table will actually deliver, interpolation included.
 */
export function fitMatch(pairs: ColorPairs, size: number, title?: string): MatchFit {
  if (!Number.isInteger(size) || size < 2 || size > 256) {
    throw new Error(`${size} is not a usable cube size`);
  }
  if (pairs.count === 0) {
    throw new Error('There were no pixels to measure — every pair was dropped.');
  }

  // The two stages are fitted against each other rather than in one pass.
  // Each is a clean least squares in its own variable once the other is
  // fixed, and neither is right on its own: fitted alone, the curves take on
  // a smeared version of a cross-channel effect they cannot express, and the
  // matrix takes on a straight-line version of a per-channel curve it should
  // not touch. Two rounds is where the residual stops moving on every case
  // measured; a third changes it by hundredths of a code value.
  let matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let curves = toneCurves(pairs, matrix);
  for (let round = 0; round < 2; round++) {
    matrix = crossMatrix(pairs, curves);
    curves = toneCurves(pairs, matrix);
  }

  const data = new Float32Array(size * size * size * 3);
  const step = 1 / (size - 1);
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const at = lutIndex(size, r, g, b);
        for (let c = 0; c < 3; c++) {
          const mixed = matrix[c * 3] * (r * step)
            + matrix[c * 3 + 1] * (g * step)
            + matrix[c * 3 + 2] * (b * step);
          // The curve clamps its own input, which is what keeps a matrix that
          // reaches outside the cube from tearing a hole in the edge of the
          // table — everything past the end of the range gets the value the
          // end of the range got.
          data[at + c] = clamp01(applyCurve(curves[c], mixed));
        }
      }
    }
  }

  const lut: Lut = { kind: '3d', size, data, domainMin: [0, 0, 0], domainMax: [1, 1, 1], title };

  const corrected = new Float32Array(pairs.count * 3);
  for (let i = 0; i < pairs.count; i++) {
    const at = i * 3;
    const out = sampleLut(lut, [pairs.from[at], pairs.from[at + 1], pairs.from[at + 2]]);
    corrected[at] = out[0];
    corrected[at + 1] = out[1];
    corrected[at + 2] = out[2];
  }

  return {
    lut,
    pairs: pairs.count,
    before: summarise(differences(pairs.from, pairs.to, pairs.count)),
    after: summarise(differences(corrected, pairs.to, pairs.count)),
  };
}

/**
 * Whether a fit is worth applying at all.
 *
 * Two ways to waste someone's time: correcting a difference that was never
 * there, and shipping a table that does not move the difference that was. The
 * first is why there is a floor — a code value of drift is two steps of an
 * 8-bit ramp and nobody can see it — and the second is why the fit has to
 * account for most of what it found rather than merely some of it.
 */
export function matchIsWorthApplying(fit: MatchFit): boolean {
  return fit.before.p95 >= 1 && fit.after.p95 <= fit.before.p95 * 0.75;
}
