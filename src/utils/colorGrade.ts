// src/utils/colorGrade.ts — the grade model, defined once.
//
// Three things have to agree about what a grade means: the GLSL that shades the
// cached preview frame while a trackball is dragged, the VapourSynth Expr that
// the "Color Grade" .vkfilter emits at render time, and the reference below that
// the tests pin. Anywhere they disagree, the picture lies about the render.
//
// So the operation order lives here, in one comment, and every implementation
// follows it. It is Resolve's order:
//
//   per channel:  offset → gain (incl. white balance) → lift → gamma
//                 → contrast about the pivot → brightness
//   across:       hue rotation → saturation
//
// The Python in data/config/filter-templates/Color Grade.vkfilter builds the
// same sequence out of std.Expr. Change one, change both, and update the test.

import type { ColorGradeFilterEditor, FilterParameterValues } from '../electron.d';

/** Rec.709 luma weights. Grading happens in RGB, so luma is derived. */
export const LUMA_R = 0.2126;
export const LUMA_G = 0.7152;
export const LUMA_B = 0.0722;

/** Full-radius trackball push, in parameter units. */
const LIFT_RANGE = 0.25;
const MULTIPLY_RANGE = 0.5;
/** Channel gain at the extremes of the temperature and tint travel. */
const WHITE_RANGE = 0.2;
const TEMPERATURE_SPAN = 4000;
const TINT_SPAN = 100;

export type BallName = 'lift' | 'gamma' | 'gain' | 'offset';
export type ScalarName =
  | 'temperature' | 'tint' | 'contrast' | 'pivot' | 'saturation' | 'hue' | 'brightness';

/** One trackball: three channel values plus the master under it. */
export interface BallValues {
  r: number;
  g: number;
  b: number;
  m: number;
}

export interface GradeValues {
  lift: BallValues;
  gamma: BallValues;
  gain: BallValues;
  offset: BallValues;
  temperature: number;
  tint: number;
  contrast: number;
  pivot: number;
  saturation: number;
  hue: number;
  brightness: number;
}

/** Additive balls sit at 0, multiplicative ones at 1. */
const ADDITIVE_NEUTRAL: BallValues = { r: 0, g: 0, b: 0, m: 0 };
const MULTIPLY_NEUTRAL: BallValues = { r: 1, g: 1, b: 1, m: 1 };

export const BALL_NEUTRAL: Record<BallName, BallValues> = {
  lift: ADDITIVE_NEUTRAL,
  offset: ADDITIVE_NEUTRAL,
  gamma: MULTIPLY_NEUTRAL,
  gain: MULTIPLY_NEUTRAL,
};

/** Resolve pivots contrast at 0.435, not at middle grey. */
export const GRADE_NEUTRAL: GradeValues = {
  lift: ADDITIVE_NEUTRAL,
  gamma: MULTIPLY_NEUTRAL,
  gain: MULTIPLY_NEUTRAL,
  offset: ADDITIVE_NEUTRAL,
  temperature: 0,
  tint: 0,
  contrast: 1,
  pivot: 0.435,
  saturation: 1,
  hue: 0,
  brightness: 0,
};

export interface ScalarSpec {
  name: ScalarName;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Decimal places in the readout; Kelvin and degrees read as integers. */
  precision: number;
  suffix?: string;
}

/** Order here is the order the tone grid renders in. */
export const SCALAR_SPECS: readonly ScalarSpec[] = [
  { name: 'temperature', label: 'Temp', min: -TEMPERATURE_SPAN, max: TEMPERATURE_SPAN, step: 10, precision: 0, suffix: 'K' },
  { name: 'tint', label: 'Tint', min: -TINT_SPAN, max: TINT_SPAN, step: 0.5, precision: 1 },
  { name: 'contrast', label: 'Contrast', min: 0, max: 2, step: 0.005, precision: 3 },
  { name: 'pivot', label: 'Pivot', min: 0.05, max: 0.95, step: 0.005, precision: 3 },
  { name: 'saturation', label: 'Saturation', min: 0, max: 3, step: 0.005, precision: 3 },
  { name: 'hue', label: 'Hue', min: -180, max: 180, step: 0.5, precision: 1, suffix: '°' },
  { name: 'brightness', label: 'Brightness', min: -0.5, max: 0.5, step: 0.002, precision: 3 },
];

export const BALL_SPECS: readonly { name: BallName; label: string; hint: string }[] = [
  { name: 'lift', label: 'Lift', hint: 'shadows' },
  { name: 'gamma', label: 'Gamma', hint: 'midtones' },
  { name: 'gain', label: 'Gain', hint: 'highlights' },
  { name: 'offset', label: 'Offset', hint: 'whole image' },
];

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);
const finite = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/* ------------------------------------------------------------------ */
/* Trackball geometry                                                  */
/* ------------------------------------------------------------------ */

// R, G and B sit 120 degrees apart with red at the top, so a puck pushed
// straight up is a pure red push. The three cosines sum to zero at every
// angle, which is what keeps a ball chromatic: it redistributes colour and
// leaves overall level to the master bar underneath it.
const ROOT3_OVER_2 = Math.sqrt(3) / 2;

/** Puck position in the unit disc to per-channel deltas. */
export function puckToDeltas(x: number, y: number): { r: number; g: number; b: number } {
  return {
    r: y,
    g: -ROOT3_OVER_2 * x - 0.5 * y,
    b: ROOT3_OVER_2 * x - 0.5 * y,
  };
}

/** The exact inverse, so a stored grade puts the puck back where it was. */
export function deltasToPuck(r: number, g: number, b: number): { x: number; y: number } {
  return { x: (b - g) / Math.sqrt(3), y: r };
}

/**
 * Travel of each ball's master bar.
 *
 * Lives with the grade model rather than the widget: the black point solver
 * has to know what it is allowed to ask for, and a second copy of these
 * numbers is a second thing to keep in step.
 */
export const MASTER_RANGE: Record<BallName, { min: number; max: number }> = {
  lift: { min: -0.5, max: 0.5 },
  offset: { min: -0.5, max: 0.5 },
  gamma: { min: 0.25, max: 4 },
  gain: { min: 0, max: 4 },
};

const ballScale = (name: BallName) => (name === 'lift' || name === 'offset' ? LIFT_RANGE : MULTIPLY_RANGE);
const ballBase = (name: BallName) => (name === 'lift' || name === 'offset' ? 0 : 1);

/** Puck position to the three channel values of a ball, master untouched. */
export function puckToBall(name: BallName, x: number, y: number, master: number): BallValues {
  const deltas = puckToDeltas(x, y);
  const scale = ballScale(name);
  const base = ballBase(name);
  return {
    r: base + deltas.r * scale,
    g: base + deltas.g * scale,
    b: base + deltas.b * scale,
    m: master,
  };
}

/** Where the puck sits for a ball's current channel values. */
export function ballToPuck(name: BallName, ball: BallValues): { x: number; y: number } {
  const scale = ballScale(name);
  const base = ballBase(name);
  const puck = deltasToPuck((ball.r - base) / scale, (ball.g - base) / scale, (ball.b - base) / scale);
  // A hand-edited .vkfilter can hold channel values no puck could produce.
  // Showing the projection is honest; letting it escape the disc is not.
  const radius = Math.hypot(puck.x, puck.y);
  if (radius <= 1) return puck;
  return { x: puck.x / radius, y: puck.y / radius };
}

/* ------------------------------------------------------------------ */
/* The grade itself                                                    */
/* ------------------------------------------------------------------ */

/**
 * Temperature and tint as per-channel gains. Warming lifts red and drops blue;
 * tint trades green against magenta. The spans are chosen so a full push is a
 * visible but recoverable 20% channel swing, not a wash.
 */
export function whiteBalance(temperature: number, tint: number): { r: number; g: number; b: number } {
  const t = clamp(temperature / TEMPERATURE_SPAN, -1, 1) * WHITE_RANGE;
  const n = clamp(tint / TINT_SPAN, -1, 1) * WHITE_RANGE;
  return { r: 1 + t, g: 1 + n, b: 1 - t };
}

/** Everything a single channel does, before the channels are mixed. */
function channel(value: number, offset: number, gain: number, lift: number, invGamma: number, values: GradeValues): number {
  let v = value + offset;
  // One ramp, so black lands on lift and white lands on gain, independently.
  // Scaling by gain and then mapping through lift made white come out at
  // gain + lift * (1 - gain): every lift move dragged the highlights with it.
  // At the default gain of 1 the two are identical, so only grades using both
  // controls change.
  v = v * (gain - lift) + lift;
  // pow needs a non-negative base and nothing more. Clamping the top here
  // flattened every highlight above 1 into the same value before gamma and
  // contrast had a chance to bring them back, and made an overshoot of 0.001
  // look exactly like an overshoot of 0.05 on the scopes.
  v = Math.max(v, 0);
  v = Math.pow(v, invGamma);
  v = (v - values.pivot) * values.contrast + values.pivot;
  v = v + values.brightness;
  return clamp(v, 0, 1);
}

/** Per-channel coefficients, folded once so the shader and Expr agree. */
export function channelTerms(values: GradeValues) {
  const white = whiteBalance(values.temperature, values.tint);
  const safeGamma = (c: number, m: number) => 1 / Math.max(0.01, c * m);
  return {
    offset: {
      r: values.offset.r + values.offset.m,
      g: values.offset.g + values.offset.m,
      b: values.offset.b + values.offset.m,
    },
    gain: {
      r: values.gain.r * values.gain.m * white.r,
      g: values.gain.g * values.gain.m * white.g,
      b: values.gain.b * values.gain.m * white.b,
    },
    lift: {
      r: values.lift.r + values.lift.m,
      g: values.lift.g + values.lift.m,
      b: values.lift.b + values.lift.m,
    },
    invGamma: {
      r: safeGamma(values.gamma.r, values.gamma.m),
      g: safeGamma(values.gamma.g, values.gamma.m),
      b: safeGamma(values.gamma.b, values.gamma.m),
    },
  };
}

/**
 * The reference grade. The shader and the emitted Expr must match this to the
 * tolerance the tests assert; it is the definition, not a preview shortcut.
 */
export function gradePixel(rgb: readonly [number, number, number], values: GradeValues): [number, number, number] {
  const terms = channelTerms(values);
  const r = channel(rgb[0], terms.offset.r, terms.gain.r, terms.lift.r, terms.invGamma.r, values);
  const g = channel(rgb[1], terms.offset.g, terms.gain.g, terms.lift.g, terms.invGamma.g, values);
  const b = channel(rgb[2], terms.offset.b, terms.gain.b, terms.lift.b, terms.invGamma.b, values);

  const y = LUMA_R * r + LUMA_G * g + LUMA_B * b;
  const cr = r - y;
  const cb = b - y;
  const angle = (values.hue * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const crRotated = cb * sin + cr * cos;
  const cbRotated = cb * cos - cr * sin;
  const s = values.saturation;

  return [
    clamp(y + crRotated * s, 0, 1),
    clamp(y - ((LUMA_R * crRotated + LUMA_B * cbRotated) * s) / LUMA_G, 0, 1),
    clamp(y + cbRotated * s, 0, 1),
  ];
}

export interface BlackPointSolution {
  values: GradeValues;
  /** True when the answer had to be trimmed to what the controls can express. */
  clamped: boolean;
}

/**
 * The lift that puts a sampled pixel on the black point.
 *
 * The ramp is out = (x + offset) * (gain - lift) + lift, so asking for out = 0
 * gives lift = -u * gain / (1 - u) with u = x + offset. Solved per channel,
 * which is what neutralises a cast in the shadows as well as setting the level.
 *
 * It targets the ramp, not the final pixel. Contrast, brightness and gamma sit
 * downstream and will move the result away from zero — which is correct, and
 * is what a black point means in Resolve too: the primaries put black where
 * you asked, and the tone controls do what you asked afterwards.
 *
 * Returns null when the pixel cannot be a black point: as u approaches white
 * the lift needed runs away to negative infinity, and a picker that answered
 * anyway would silently produce nonsense.
 */
export function solveBlackPoint(
  values: GradeValues,
  sample: readonly [number, number, number],
): BlackPointSolution | null {
  const terms = channelTerms(values);
  const names = ['r', 'g', 'b'] as const;
  const folded: number[] = [];

  for (let i = 0; i < 3; i++) {
    const u = sample[i] + terms.offset[names[i]];
    // Past about three quarters the solution grows faster than the control can
    // follow, and the pixel was never a plausible black anyway.
    if (!Number.isFinite(u) || u > 0.75) return null;
    folded.push((-u * terms.gain[names[i]]) / (1 - u));
  }

  // The master carries the level and the puck carries the cast, which is how
  // the ball is built: deltas around a master always sum to zero.
  const master = (folded[0] + folded[1] + folded[2]) / 3;
  let deltas = folded.map(value => value - master);

  let clamped = false;
  const puck = deltasToPuck(deltas[0] / LIFT_RANGE, deltas[1] / LIFT_RANGE, deltas[2] / LIFT_RANGE);
  const radius = Math.hypot(puck.x, puck.y);
  if (radius > 1) {
    // Keep the direction of the cast correction and give up some of its size,
    // rather than storing a puck position the disc cannot show.
    deltas = deltas.map(value => value / radius);
    clamped = true;
  }

  const boundedMaster = clamp(master, MASTER_RANGE.lift.min, MASTER_RANGE.lift.max);
  if (boundedMaster !== master) clamped = true;

  return {
    values: {
      ...values,
      lift: { r: deltas[0], g: deltas[1], b: deltas[2], m: boundedMaster },
    },
    clamped,
  };
}

export interface WhitePointSolution {
  values: GradeValues;
  /** True when the answer had to be trimmed to what the controls can express. */
  clamped: boolean;
}

/**
 * The gain that puts a sampled pixel on the white point.
 *
 * The mirror of solveBlackPoint across the same ramp. With
 * out = (x + offset) * (gain - lift) + lift and u = x + offset, asking for
 * out = 1 gives gain = lift + (1 - lift) / u. Solved per channel, so it takes
 * the cast out of the highlights as well as setting the level.
 *
 * It reads lift as it stands, which is why auto balance solves black first:
 * the two controls share one ramp, and the white end has to be told where the
 * black end ended up. Solved the other way round, the highlights stay where
 * the old lift put them.
 *
 * The stored ball is what is left after white balance and the master, because
 * temperature and tint are already per-channel gains and are the grader's to
 * set, not the picker's to overwrite.
 *
 * Returns null when the pixel cannot be a white point: as u approaches black
 * the gain needed runs away to infinity.
 */
export function solveWhitePoint(
  values: GradeValues,
  sample: readonly [number, number, number],
): WhitePointSolution | null {
  const terms = channelTerms(values);
  const white = whiteBalance(values.temperature, values.tint);
  const names = ['r', 'g', 'b'] as const;
  const needed: number[] = [];

  for (let i = 0; i < 3; i++) {
    const name = names[i];
    const u = sample[i] + terms.offset[name];
    // Below about a quarter the solution grows faster than the control can
    // follow, and the pixel was never a plausible white anyway.
    if (!Number.isFinite(u) || u < 0.25) return null;
    const total = terms.lift[name] + (1 - terms.lift[name]) / u;
    if (!Number.isFinite(total) || total <= 0) return null;
    needed.push(total / white[name]);
  }

  // Gain is multiplicative, so its channel values sit around 1 and the master
  // multiplies them: the mean carries the level, the spread carries the cast.
  const master = (needed[0] + needed[1] + needed[2]) / 3;
  if (!(master > 0)) return null;
  let deltas = needed.map(value => value / master - 1);

  let clamped = false;
  const puck = deltasToPuck(
    deltas[0] / MULTIPLY_RANGE,
    deltas[1] / MULTIPLY_RANGE,
    deltas[2] / MULTIPLY_RANGE,
  );
  const radius = Math.hypot(puck.x, puck.y);
  if (radius > 1) {
    // Keep the direction of the cast correction and give up some of its size,
    // rather than storing a puck position the disc cannot show.
    deltas = deltas.map(value => value / radius);
    clamped = true;
  }

  const boundedMaster = clamp(master, MASTER_RANGE.gain.min, MASTER_RANGE.gain.max);
  if (boundedMaster !== master) clamped = true;

  return {
    values: {
      ...values,
      gain: { r: 1 + deltas[0], g: 1 + deltas[1], b: 1 + deltas[2], m: boundedMaster },
    },
    clamped,
  };
}


export interface NeutralSolution {
  values: GradeValues;
  /** True when the cast was stronger than temperature and tint can express. */
  clamped: boolean;
}

/**
 * The temperature and tint that make a sampled pixel grey.
 *
 * The other two pickers each solve one ball; this one solves the two tone
 * sliders, because that is what a colour cast is stored in. It is the picker
 * with the least freedom: temperature and tint are two numbers against three
 * channels, which is exactly right — they can take out a cast that runs along
 * the warm/cool and green/magenta axes, and nothing else. A cast that does not
 * run along them is not a white balance error.
 *
 * Fold the ramp for one channel with the white balance left symbolic. With
 * u = x + offset, c = gain.channel * gain.master and L the folded lift,
 *
 *   out = u * (c * w - L) + L  =  (u * c) * w  +  L * (1 - u)  =  A * w + B
 *
 * so each output is linear in its own white balance gain. whiteBalance() puts
 * those gains at (1 + t, 1 + n, 1 - t), and asking for out_r = out_g = out_b
 * gives two equations in t and n:
 *
 *   t = (A_b + B_b - A_r - B_r) / (A_r + A_b)
 *   n = (A_r * (1 + t) + B_r - B_g) / A_g - 1
 *
 * Exact, and it accounts for a lift that already carries a cast of its own —
 * which it will, if a black point was picked first.
 *
 * Returns null for a pixel with no cast information in it: at either end of
 * the range the channels are held together by the clamps, not by the balance.
 */
export function solveNeutral(
  values: GradeValues,
  sample: readonly [number, number, number],
): NeutralSolution | null {
  const terms = channelTerms(values);
  const names = ['r', 'g', 'b'] as const;
  const A: number[] = [];
  const B: number[] = [];

  for (let i = 0; i < 3; i++) {
    const name = names[i];
    const u = sample[i] + terms.offset[name];
    // Near black there is nothing to balance, and near white the answer is
    // whatever the clamp decided. Neither is a grey card.
    if (!Number.isFinite(u) || u < 0.05 || u > 0.95) return null;
    // terms.gain already has white balance folded in, so take it back out:
    // it is the unknown here, not an input.
    const c = terms.gain[name] / whiteBalance(values.temperature, values.tint)[name];
    A.push(u * c);
    B.push(terms.lift[name] * (1 - u));
  }

  if (!(A[0] + A[2] > 0) || !(A[1] > 0)) return null;

  const t = (A[2] + B[2] - A[0] - B[0]) / (A[0] + A[2]);
  const n = (A[0] * (1 + t) + B[0] - B[1]) / A[1] - 1;
  if (!Number.isFinite(t) || !Number.isFinite(n)) return null;

  const temperature = (t / WHITE_RANGE) * TEMPERATURE_SPAN;
  const tint = (n / WHITE_RANGE) * TINT_SPAN;
  const boundedTemp = clamp(temperature, -TEMPERATURE_SPAN, TEMPERATURE_SPAN);
  const boundedTint = clamp(tint, -TINT_SPAN, TINT_SPAN);

  return {
    values: { ...values, temperature: boundedTemp, tint: boundedTint },
    clamped: boundedTemp !== temperature || boundedTint !== tint,
  };
}
/* ------------------------------------------------------------------ */
/* Reading the two ends off the picture                                */
/* ------------------------------------------------------------------ */

/** Share of the picture each tail is averaged over. */
const TAIL_FRACTION = 0.005;
/** Nothing this dark across a whole row or column is picture; it is matte. */
const MATTE_LUMA = 0.02;
/** Below this many pixels of picture the tails are noise, not a distribution. */
const MIN_PICTURE_PIXELS = 64;

export interface FramePoints {
  /** Mean colour of the darkest tail, ignoring letterbox and pillarbox. */
  black: [number, number, number];
  /** Mean colour of the brightest tail. */
  white: [number, number, number];
}

/**
 * The darkest and brightest ends of a frame, as colours.
 *
 * Takes the scope sample — the same 240px-wide RGB buffer the scopes grade, of
 * the picture entering this grade — so auto balance costs no extra readback.
 *
 * The matte trim is not a nicety. A letterboxed frame is bordered by exact
 * black, so the darkest half a percent of it is the bars every time, and an
 * auto balance reading them would answer "already black" for every frame that
 * has them, which is most film. Rows and columns holding no pixel above
 * MATTE_LUMA are dropped before the tails are taken.
 *
 * Tails are averaged rather than read at a single percentile, so one hot pixel
 * or one dead one cannot set the point on its own.
 */
export function framePoints(sample: Float32Array | null): FramePoints | null {
  if (!sample || sample.length < 5) return null;
  const width = Math.round(sample[0]);
  const height = Math.round(sample[1]);
  if (!(width > 0) || !(height > 0) || sample.length < 2 + width * height * 3) return null;

  // Luma once, up front: the trim, the sort and the tails all read it, and at
  // 240x135 it is a 130KB array and about a millisecond.
  const luma = new Float32Array(width * height);
  for (let i = 0; i < luma.length; i++) {
    const o = 2 + i * 3;
    luma[i] = LUMA_R * sample[o] + LUMA_G * sample[o + 1] + LUMA_B * sample[o + 2];
  }

  const rowIsPicture = (y: number) => {
    for (let x = 0; x < width; x++) if (luma[y * width + x] > MATTE_LUMA) return true;
    return false;
  };
  const columnIsPicture = (x: number) => {
    for (let y = 0; y < height; y++) if (luma[y * width + x] > MATTE_LUMA) return true;
    return false;
  };

  let top = 0;
  let bottom = height - 1;
  while (top <= bottom && !rowIsPicture(top)) top++;
  while (bottom > top && !rowIsPicture(bottom)) bottom--;
  let left = 0;
  let right = width - 1;
  while (left <= right && !columnIsPicture(left)) left++;
  while (right > left && !columnIsPicture(right)) right--;
  if (top > bottom || left > right) return null; // a frame that is all matte

  const count = (bottom - top + 1) * (right - left + 1);
  if (count < MIN_PICTURE_PIXELS) return null;

  const order = new Uint32Array(count);
  let n = 0;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) order[n++] = y * width + x;
  }
  // A comparator sort of ~32k entries, once, on a button press. It is not on
  // the drag path, so it does not need to be a histogram.
  order.sort((a, b) => luma[a] - luma[b]);

  const tail = Math.max(1, Math.round(count * TAIL_FRACTION));
  const mean = (from: number): [number, number, number] => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = from; i < from + tail; i++) {
      const o = 2 + order[i] * 3;
      r += sample[o];
      g += sample[o + 1];
      b += sample[o + 2];
    }
    return [r / tail, g / tail, b / tail];
  };

  return { black: mean(0), white: mean(count - tail) };
}

export interface AutoBalanceSolution {
  values: GradeValues;
  clamped: boolean;
  /** Which ends the picture actually gave an answer for. */
  solved: { black: boolean; white: boolean };
}

/**
 * Lift and gain solved together, so both ends land where they were asked to.
 *
 * The two pickers each solve one control against the other as it stands, which
 * is what a picker should do. Running them in sequence does not give you both
 * ends, though, because they share one ramp: solving gain for white moves the
 * black the lift solve had just placed, and solving lift afterwards moves the
 * white back. There is no order that fixes it — the system has to be solved as
 * a system.
 *
 * Per channel, with u = x + offset, the ramp out = u * (G - L) + L must satisfy
 *
 *   u_black * (G - L) + L = 0        G - L = 1 / (u_white - u_black)
 *   u_white * (G - L) + L = 1   =>   L     = -u_black / (u_white - u_black)
 *
 * which is exact, and needs only that the two ends are far enough apart for the
 * answer to sit inside the controls.
 */
export function solveRamp(
  values: GradeValues,
  black: readonly [number, number, number],
  white: readonly [number, number, number],
): { values: GradeValues; clamped: boolean } | null {
  const terms = channelTerms(values);
  const balance = whiteBalance(values.temperature, values.tint);
  const names = ['r', 'g', 'b'] as const;
  const lifts: number[] = [];
  const gains: number[] = [];

  for (let i = 0; i < 3; i++) {
    const name = names[i];
    const low = black[i] + terms.offset[name];
    const high = white[i] + terms.offset[name];
    const span = high - low;
    // A slope of 1/span, so a quarter of the range is already a gain of 4 —
    // the top of the master's travel. Flatter than that and the answer is
    // outside every control it would have to be stored in.
    if (!Number.isFinite(span) || span < 0.25) return null;

    const lift = -low / span;
    const gain = lift + 1 / span;
    if (!Number.isFinite(lift) || !Number.isFinite(gain) || gain <= 0) return null;
    lifts.push(lift);
    gains.push(gain / balance[name]);
  }

  // Both balls split the same way: the master carries the level and the puck
  // carries the cast. Lift is additive so its channels sum to zero around the
  // master; gain is multiplicative so its channels average to one.
  const liftMaster = (lifts[0] + lifts[1] + lifts[2]) / 3;
  const gainMaster = (gains[0] + gains[1] + gains[2]) / 3;
  if (!(gainMaster > 0)) return null;

  let liftDeltas = lifts.map(value => value - liftMaster);
  let gainDeltas = gains.map(value => value / gainMaster - 1);
  let clamped = false;

  const trim = (deltas: number[], range: number) => {
    const puck = deltasToPuck(deltas[0] / range, deltas[1] / range, deltas[2] / range);
    const radius = Math.hypot(puck.x, puck.y);
    if (radius <= 1) return deltas;
    clamped = true;
    return deltas.map(value => value / radius);
  };
  liftDeltas = trim(liftDeltas, LIFT_RANGE);
  gainDeltas = trim(gainDeltas, MULTIPLY_RANGE);

  const boundedLift = clamp(liftMaster, MASTER_RANGE.lift.min, MASTER_RANGE.lift.max);
  const boundedGain = clamp(gainMaster, MASTER_RANGE.gain.min, MASTER_RANGE.gain.max);
  if (boundedLift !== liftMaster || boundedGain !== gainMaster) clamped = true;

  return {
    values: {
      ...values,
      lift: { r: liftDeltas[0], g: liftDeltas[1], b: liftDeltas[2], m: boundedLift },
      gain: { r: 1 + gainDeltas[0], g: 1 + gainDeltas[1], b: 1 + gainDeltas[2], m: boundedGain },
    },
    clamped,
  };
}

/**
 * Both ends of the ramp, read off the frame and set at once.
 *
 * The joint solve is the answer whenever the picture has two ends far enough
 * apart to have one. A picture that does not — all shadow, all highlight, or
 * flat enough that the slope between them is outside the controls — still has
 * one end worth setting, so it falls back to the pickers and says which end it
 * managed. Null only when the frame gave neither.
 */
export function autoBalance(
  values: GradeValues,
  sample: Float32Array | null,
): AutoBalanceSolution | null {
  const points = framePoints(sample);
  if (!points) return null;

  const both = solveRamp(values, points.black, points.white);
  if (both) {
    return { values: both.values, clamped: both.clamped, solved: { black: true, white: true } };
  }

  const black = solveBlackPoint(values, points.black);
  const white = solveWhitePoint(black?.values ?? values, points.white);
  if (!black && !white) return null;

  return {
    values: white?.values ?? black!.values,
    clamped: Boolean(black?.clamped || white?.clamped),
    solved: { black: Boolean(black), white: Boolean(white) },
  };
}

/** A neutral grade emits no VapourSynth stage and needs no shader pass. */
export function isNeutralGrade(values: GradeValues): boolean {
  const ballsNeutral = BALL_SPECS.every(({ name }) => {
    const ball = values[name];
    const neutral = BALL_NEUTRAL[name];
    return ball.r === neutral.r && ball.g === neutral.g && ball.b === neutral.b && ball.m === neutral.m;
  });
  return (
    ballsNeutral &&
    values.temperature === 0 &&
    values.tint === 0 &&
    values.contrast === 1 &&
    values.saturation === 1 &&
    values.hue === 0 &&
    values.brightness === 0
  );
}

/* ------------------------------------------------------------------ */
/* Reading and writing the filter's parameters                         */
/* ------------------------------------------------------------------ */

const BALL_CHANNELS = ['r', 'g', 'b', 'm'] as const;

/**
 * A .vkfilter maps each editor role onto its own variable names, so the Python
 * stays readable and hand-editable. These two functions are the only places
 * that know about that indirection.
 */
export function gradeFromParameters(
  editor: ColorGradeFilterEditor,
  parameters: FilterParameterValues | undefined,
): GradeValues {
  const ball = (name: BallName): BallValues => {
    const names = editor.variables[name];
    const neutral = BALL_NEUTRAL[name];
    const read = (index: number, fallback: number) => finite(parameters?.[names?.[index] ?? ''], fallback);
    return {
      r: read(0, neutral.r),
      g: read(1, neutral.g),
      b: read(2, neutral.b),
      m: read(3, neutral.m),
    };
  };
  const scalar = (name: ScalarName) => finite(parameters?.[editor.variables[name]], GRADE_NEUTRAL[name]);

  return {
    lift: ball('lift'),
    gamma: ball('gamma'),
    gain: ball('gain'),
    offset: ball('offset'),
    temperature: scalar('temperature'),
    tint: scalar('tint'),
    contrast: scalar('contrast'),
    pivot: scalar('pivot'),
    saturation: scalar('saturation'),
    hue: scalar('hue'),
    brightness: scalar('brightness'),
  };
}

export function gradeToParameters(
  editor: ColorGradeFilterEditor,
  values: GradeValues,
  parameters?: FilterParameterValues,
): FilterParameterValues {
  const next: FilterParameterValues = { ...parameters };
  for (const { name } of BALL_SPECS) {
    const names = editor.variables[name];
    BALL_CHANNELS.forEach((channelName, index) => {
      const variable = names?.[index];
      if (variable) next[variable] = values[name][channelName];
    });
  }
  for (const { name } of SCALAR_SPECS) {
    const variable = editor.variables[name];
    if (variable) next[variable] = values[name];
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* The shader                                                          */
/* ------------------------------------------------------------------ */

/**
 * WebGL1 fragment shader. Reads the cached "before" frame and applies the same
 * sequence as gradePixel above, so dragging a ball is a texture read rather
 * than a vspipe render. Uniforms carry the folded per-channel terms.
 */
export const GRADE_FRAGMENT_SHADER = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uFrame;
uniform vec3 uOffset;
uniform vec3 uGain;
uniform vec3 uLift;
uniform vec3 uInvGamma;
uniform float uContrast;
uniform float uPivot;
uniform float uBrightness;
uniform float uSaturation;
uniform float uHueCos;
uniform float uHueSin;
// Display only. Never touches the grade, and so never affects agreement with
// the emitted Python — it decides what is drawn over the result, not what the
// result is.
uniform float uClipMarks;

const vec3 LUMA = vec3(${LUMA_R}, ${LUMA_G}, ${LUMA_B});

void main() {
  vec3 c = texture2D(uFrame, vUv).rgb;

  c = c + uOffset;
  c = c * (uGain - uLift) + uLift;
  c = max(c, vec3(0.0));
  c = pow(c, uInvGamma);
  c = (c - vec3(uPivot)) * uContrast + vec3(uPivot);
  c = c + vec3(uBrightness);

  // Watched at both clamps, because either can be the one that flattens a
  // pixel: this per-channel stage, and the output after saturation. Reading
  // only the final value would miss a channel that was already pinned here
  // and then pulled back inside the range by a desaturation.
  bool clipHigh = any(greaterThan(c, vec3(0.999)));
  bool clipLow = any(lessThan(c, vec3(0.001)));

  c = clamp(c, 0.0, 1.0);

  float y = dot(c, LUMA);
  float cr = c.r - y;
  float cb = c.b - y;
  float crR = cb * uHueSin + cr * uHueCos;
  float cbR = cb * uHueCos - cr * uHueSin;

  vec3 outColor = vec3(
    y + crR * uSaturation,
    y - ((LUMA.r * crR + LUMA.b * cbR) * uSaturation) / LUMA.g,
    y + cbR * uSaturation
  );

  clipHigh = clipHigh || any(greaterThan(outColor, vec3(0.999)));
  clipLow = clipLow || any(lessThan(outColor, vec3(0.001)));

  vec3 shown = clamp(outColor, 0.0, 1.0);

  // Diagonal stripes rather than a flat fill: a solid red patch is exactly
  // what a blown highlight already looks like, so a flat marker is the one
  // thing that cannot be told apart from what it is marking.
  if (uClipMarks > 0.5 && (clipHigh || clipLow)) {
    if (mod(gl_FragCoord.x + gl_FragCoord.y, 8.0) < 4.0) {
      shown = clipHigh ? vec3(1.0, 0.16, 0.10) : vec3(0.16, 0.45, 1.0);
    }
  }

  gl_FragColor = vec4(shown, 1.0);
}
`;

export const GRADE_VERTEX_SHADER = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  // The frame texture is uploaded top-down, so flip V rather than the image.
  vUv = vec2(aPosition.x * 0.5 + 0.5, 0.5 - aPosition.y * 0.5);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

/** Uniform values for one grade, in the order the shader declares them. */
export function shaderUniforms(values: GradeValues) {
  const terms = channelTerms(values);
  const angle = (values.hue * Math.PI) / 180;
  return {
    uOffset: [terms.offset.r, terms.offset.g, terms.offset.b] as const,
    uGain: [terms.gain.r, terms.gain.g, terms.gain.b] as const,
    uLift: [terms.lift.r, terms.lift.g, terms.lift.b] as const,
    uInvGamma: [terms.invGamma.r, terms.invGamma.g, terms.invGamma.b] as const,
    uContrast: values.contrast,
    uPivot: values.pivot,
    uBrightness: values.brightness,
    uSaturation: values.saturation,
    uHueCos: Math.cos(angle),
    uHueSin: Math.sin(angle),
  };
}
