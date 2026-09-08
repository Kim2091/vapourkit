import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as TOML from '@iarna/toml';
import {
  GRADE_NEUTRAL,
  BALL_SPECS,
  SCALAR_SPECS,
  gradePixel,
  isNeutralGrade,
  whiteBalance,
  channelTerms,
  puckToBall,
  ballToPuck,
  gradeFromParameters,
  gradeToParameters,
  LUMA_R,
  LUMA_G,
  LUMA_B,
  type GradeValues,
  solveBlackPoint,
  solveWhitePoint,
  solveRamp,
  solveNeutral,
  framePoints,
  autoBalance,
} from './colorGrade';
import type { ColorGradeFilterEditor } from '../electron.d';

// The shipped copy, not the runtime one under data/ — that directory is
// gitignored and is seeded from here on first run, so testing it would pass
// locally and fail on a fresh clone.
const TEMPLATE_PATH = path.join(
  __dirname, '..', '..', 'include', 'filter_templates', 'Color Grade.vkfilter',
);

function loadTemplate() {
  return TOML.parse(fs.readFileSync(TEMPLATE_PATH, 'utf-8')) as unknown as {
    name: string;
    code: string;
    variables: Record<string, { type?: string; default?: number; description?: string }>;
    editor: ColorGradeFilterEditor;
  };
}

const graded: GradeValues = {
  lift: { r: 0.0, g: 0.0, b: 0.03, m: 0.02 },
  gamma: { r: 1.0, g: 1.02, b: 0.98, m: 0.96 },
  gain: { r: 1.12, g: 1.0, b: 0.94, m: 1.08 },
  offset: { r: 0.01, g: 0, b: -0.01, m: 0 },
  temperature: 320,
  tint: -2,
  contrast: 1.06,
  pivot: 0.44,
  saturation: 1.1,
  hue: 4,
  brightness: -0.01,
};

describe('grade model', () => {
  it('leaves the picture alone at neutral', () => {
    for (const pixel of [[0, 0, 0], [0.25, 0.5, 0.75], [1, 1, 1]] as const) {
      const out = gradePixel(pixel, GRADE_NEUTRAL);
      out.forEach((value, i) => expect(value).toBeCloseTo(pixel[i], 6));
    }
    expect(isNeutralGrade(GRADE_NEUTRAL)).toBe(true);
    expect(isNeutralGrade(graded)).toBe(false);
  });

  it('keeps every output in range, including at the extremes of every control', () => {
    const extremes: GradeValues[] = SCALAR_SPECS.flatMap(spec => [
      { ...GRADE_NEUTRAL, [spec.name]: spec.min },
      { ...GRADE_NEUTRAL, [spec.name]: spec.max },
    ]) as GradeValues[];
    extremes.push({ ...GRADE_NEUTRAL, gain: { r: 4, g: 4, b: 4, m: 4 } });
    extremes.push({ ...GRADE_NEUTRAL, lift: { r: -0.5, g: -0.5, b: -0.5, m: -0.5 } });
    extremes.push({ ...GRADE_NEUTRAL, gamma: { r: 0.25, g: 4, b: 0.25, m: 0.25 } });

    for (const values of extremes) {
      for (const pixel of [[0, 0, 0], [0.5, 0.5, 0.5], [1, 0.2, 0.8], [1, 1, 1]] as const) {
        for (const channel of gradePixel(pixel, values)) {
          expect(Number.isFinite(channel)).toBe(true);
          expect(channel).toBeGreaterThanOrEqual(0);
          expect(channel).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('lands black on lift and white on gain, independently', () => {
    // The property that makes the two controls usable: setting a black point
    // must not drag the highlights, and setting a white point must not drag
    // the floor. Scaling by gain and then mapping through lift put white at
    // gain + lift * (1 - gain) instead, so every lift move shifted it.
    const values = {
      ...GRADE_NEUTRAL,
      lift: { r: 0, g: 0, b: 0, m: 0.1 },
      gain: { r: 1, g: 1, b: 1, m: 0.8 },
    };

    const black = gradePixel([0, 0, 0], values);
    const white = gradePixel([1, 1, 1], values);

    black.forEach(v => expect(v).toBeCloseTo(0.1, 6));
    white.forEach(v => expect(v).toBeCloseTo(0.8, 6));
  });

  it('keeps highlight headroom alive until the output', () => {
    // Two pixels driven above 1 by gain must stay distinguishable, so a gamma
    // that pulls them back recovers detail rather than a flat patch. Clamping
    // before pow made both of these land on exactly 1.
    const values = {
      ...GRADE_NEUTRAL,
      gain: { r: 1, g: 1, b: 1, m: 1.5 },
      contrast: 0.5,
      pivot: 0.5,
    };

    // Gain drives both above 1, then contrast about the pivot brings them
    // back. Clamped before pow, both arrived as exactly 1 and came out equal.
    const [lower] = gradePixel([0.7, 0.7, 0.7], values);
    const [higher] = gradePixel([0.9, 0.9, 0.9], values);

    expect(lower).toBeLessThan(higher);
    expect(higher).toBeLessThan(1);
  });

  it('survives a zero gamma without producing NaN', () => {
    const out = gradePixel([0.5, 0.5, 0.5], { ...GRADE_NEUTRAL, gamma: { r: 0, g: 0, b: 0, m: 0 } });
    out.forEach(value => expect(Number.isFinite(value)).toBe(true));
  });

  it('warms by lifting red over blue', () => {
    const warm = whiteBalance(4000, 0);
    expect(warm.r).toBeGreaterThan(1);
    expect(warm.b).toBeLessThan(1);
    expect(warm.g).toBe(1);
    expect(whiteBalance(0, 0)).toEqual({ r: 1, g: 1, b: 1 });
  });

  it('holds luma while saturation and hue move', () => {
    const pixel = [0.6, 0.4, 0.25] as const;
    const luma = (c: readonly number[]) => LUMA_R * c[0] + LUMA_G * c[1] + LUMA_B * c[2];
    const before = luma(pixel);
    for (const values of [
      { ...GRADE_NEUTRAL, saturation: 1.8 },
      { ...GRADE_NEUTRAL, saturation: 0 },
      { ...GRADE_NEUTRAL, hue: 40 },
    ]) {
      expect(luma(gradePixel(pixel, values))).toBeCloseTo(before, 6);
    }
  });

  it('drains all colour at zero saturation', () => {
    const [r, g, b] = gradePixel([0.8, 0.3, 0.1], { ...GRADE_NEUTRAL, saturation: 0 });
    expect(g).toBeCloseTo(r, 6);
    expect(b).toBeCloseTo(r, 6);
  });
});

describe('the black point solver', () => {
  // Downstream of the ramp everything is neutral, so a ramp that lands on zero
  // lands the pixel on zero: pow(0) is 0, contrast about any pivot leaves 0
  // alone at contrast 1, and a black pixel has no chroma for hue or saturation
  // to move. That makes the whole grade a fair check on the ramp.
  const base = {
    ...GRADE_NEUTRAL,
    gain: { r: 1.05, g: 1, b: 0.92, m: 0.95 },
    offset: { r: 0.004, g: 0, b: -0.002, m: 0.01 },
    temperature: 500,
    tint: -8,
    saturation: 1.3,
    hue: 12,
  };

  it('puts the sampled pixel on black, cast and all', () => {
    const sample: [number, number, number] = [0.07, 0.062, 0.083];

    const solved = solveBlackPoint(base, sample);

    expect(solved).not.toBeNull();
    expect(solved!.clamped).toBe(false);
    gradePixel(sample, solved!.values).forEach(v => expect(v).toBeCloseTo(0, 6));
  });

  it('leaves an already-black pixel alone', () => {
    const solved = solveBlackPoint(GRADE_NEUTRAL, [0, 0, 0]);

    expect(solved).not.toBeNull();
    const { r, g, b, m } = solved!.values.lift;
    [r, g, b, m].forEach(v => expect(v).toBeCloseTo(0, 9));
  });

  it('keeps the puck on the disc, and says when it had to', () => {
    // A wildly coloured "black" asks for more cast correction than the disc
    // holds. Trimming it is right; doing so silently is not.
    const solved = solveBlackPoint(GRADE_NEUTRAL, [0.5, 0.02, 0.02]);

    expect(solved).not.toBeNull();
    expect(solved!.clamped).toBe(true);

    const lift = solved!.values.lift;
    const puck = ballToPuck('lift', lift);
    expect(Math.hypot(puck.x, puck.y)).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('refuses a pixel too bright to be a black point', () => {
    // The lift needed runs away to negative infinity as the sample approaches
    // white, so answering at all would be answering with nonsense.
    expect(solveBlackPoint(GRADE_NEUTRAL, [0.9, 0.9, 0.9])).toBeNull();
  });
});


describe('the white point solver', () => {
  // The mirror of the black point fixture. Downstream of the ramp the grade is
  // neutral, so a ramp landing the pixel on 1 lands the pixel on 1: pow(1) is
  // 1, contrast about any pivot leaves nothing to move once the channels agree,
  // and a white pixel has no chroma for hue or saturation to turn.
  const base = {
    ...GRADE_NEUTRAL,
    lift: { r: 0.01, g: 0, b: -0.008, m: 0.02 },
    offset: { r: 0.004, g: 0, b: -0.002, m: 0.01 },
    temperature: 500,
    tint: -8,
  };

  it('puts the sampled pixel on white, cast and all', () => {
    const sample: [number, number, number] = [0.86, 0.9, 0.81];

    const solved = solveWhitePoint(base, sample);

    expect(solved).not.toBeNull();
    expect(solved!.clamped).toBe(false);
    gradePixel(sample, solved!.values).forEach(v => expect(v).toBeCloseTo(1, 6));
  });

  it('leaves an already-white pixel alone', () => {
    const solved = solveWhitePoint(GRADE_NEUTRAL, [1, 1, 1]);

    expect(solved).not.toBeNull();
    const { r, g, b, m } = solved!.values.gain;
    [r, g, b, m].forEach(v => expect(v).toBeCloseTo(1, 9));
  });

  it('keeps the temperature the grader set', () => {
    // White balance is a per-channel gain too. The picker solving through it
    // rather than over it is what lets a warm grade stay warm after a pick.
    const warm = { ...GRADE_NEUTRAL, temperature: 2000, tint: 15 };
    const solved = solveWhitePoint(warm, [0.8, 0.78, 0.75]);

    expect(solved).not.toBeNull();
    expect(solved!.values.temperature).toBe(2000);
    expect(solved!.values.tint).toBe(15);
    gradePixel([0.8, 0.78, 0.75], solved!.values).forEach(v => expect(v).toBeCloseTo(1, 6));
  });

  it('keeps the puck on the disc, and says when it had to', () => {
    const solved = solveWhitePoint(GRADE_NEUTRAL, [0.95, 0.3, 0.28]);

    expect(solved).not.toBeNull();
    expect(solved!.clamped).toBe(true);

    const puck = ballToPuck('gain', solved!.values.gain);
    expect(Math.hypot(puck.x, puck.y)).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('refuses a pixel too dark to be a white point', () => {
    // The gain needed runs away to infinity as the sample approaches black.
    expect(solveWhitePoint(GRADE_NEUTRAL, [0.1, 0.1, 0.1])).toBeNull();
  });
});


describe('the neutral picker', () => {
  /** How far the three channels are from agreeing, after the whole grade. */
  const spread = (rgb: readonly [number, number, number], values: GradeValues) => {
    const out = gradePixel(rgb, values);
    return Math.max(...out) - Math.min(...out);
  };

  it('makes a warm pixel grey, and says so in temperature', () => {
    const sample: [number, number, number] = [0.5, 0.45, 0.4];

    const solved = solveNeutral(GRADE_NEUTRAL, sample);

    expect(solved).not.toBeNull();
    expect(solved!.clamped).toBe(false);
    expect(spread(sample, solved!.values)).toBeLessThan(1e-6);
    // Warm in, so the correction cools: negative temperature.
    expect(solved!.values.temperature).toBeLessThan(0);
  });

  it('makes a green pixel grey through tint', () => {
    const sample: [number, number, number] = [0.44, 0.5, 0.44];

    const solved = solveNeutral(GRADE_NEUTRAL, sample);

    expect(solved).not.toBeNull();
    expect(spread(sample, solved!.values)).toBeLessThan(1e-6);
    expect(solved!.values.tint).toBeLessThan(0);
  });

  it('accounts for a lift that already carries a cast', () => {
    // The order that matters in practice: pick a black point, which puts a
    // cast in lift, then pick a neutral. Solving against the ramp rather than
    // against the raw sample is what makes the second pick land.
    const afterBlack = solveBlackPoint(GRADE_NEUTRAL, [0.06, 0.05, 0.075])!.values;
    expect(afterBlack.lift.r).not.toBeCloseTo(afterBlack.lift.b, 6);

    const sample: [number, number, number] = [0.52, 0.48, 0.46];
    const solved = solveNeutral(afterBlack, sample);

    expect(solved).not.toBeNull();
    expect(spread(sample, solved!.values)).toBeLessThan(1e-6);
  });

  it('leaves the balls alone — it is the two sliders that hold a cast', () => {
    const base = { ...GRADE_NEUTRAL, gain: { r: 1.04, g: 1, b: 0.97, m: 1.1 } };
    const solved = solveNeutral(base, [0.5, 0.47, 0.44]);

    expect(solved).not.toBeNull();
    expect(solved!.values.gain).toEqual(base.gain);
    expect(solved!.values.lift).toEqual(base.lift);
    expect(spread([0.5, 0.47, 0.44], solved!.values)).toBeLessThan(1e-6);
  });

  it('says when the cast is stronger than the sliders reach', () => {
    // Temperature tops out at a 20% channel swing; this asks for far more.
    const solved = solveNeutral(GRADE_NEUTRAL, [0.7, 0.5, 0.25]);

    expect(solved).not.toBeNull();
    expect(solved!.clamped).toBe(true);
    expect(Math.abs(solved!.values.temperature)).toBeLessThanOrEqual(4000);
    expect(Math.abs(solved!.values.tint)).toBeLessThanOrEqual(100);
  });

  it('refuses a pixel with no cast information in it', () => {
    // At either end the channels are held together by the clamps, not by the
    // balance, so the answer would be read off the clamp.
    expect(solveNeutral(GRADE_NEUTRAL, [0.01, 0.01, 0.02])).toBeNull();
    expect(solveNeutral(GRADE_NEUTRAL, [0.99, 0.98, 0.99])).toBeNull();
  });
});
describe('reading the two ends off a frame', () => {
  /** A scope sample: width, height, then RGB triples, as sampleFrame emits. */
  const frame = (
    width: number,
    height: number,
    pixel: (x: number, y: number) => [number, number, number],
  ) => {
    const out = new Float32Array(width * height * 3 + 2);
    out[0] = width;
    out[1] = height;
    let o = 2;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [r, g, b] = pixel(x, y);
        out[o++] = r;
        out[o++] = g;
        out[o++] = b;
      }
    }
    return out;
  };

  it('finds the dark and bright ends of a plain ramp', () => {
    // A horizontal ramp from 0.2 to 0.8, so the tails are known.
    const points = framePoints(frame(64, 64, x => {
      const v = 0.2 + (x / 63) * 0.6;
      return [v, v, v];
    }));

    expect(points).not.toBeNull();
    expect(points!.black[0]).toBeCloseTo(0.2, 1);
    expect(points!.white[0]).toBeCloseTo(0.8, 1);
  });

  it('ignores letterbox bars', () => {
    // This is the case that decides whether auto balance is usable at all:
    // a matte border is exact black, so untrimmed it is the darkest tail of
    // every letterboxed frame and the black end would never move.
    const bars = 12;
    const withBars = frame(64, 64, (x, y) => {
      if (y < bars || y >= 64 - bars) return [0, 0, 0];
      const v = 0.3 + (x / 63) * 0.5;
      return [v, v, v];
    });

    const points = framePoints(withBars);

    expect(points).not.toBeNull();
    // The picture's own floor, not the matte's.
    expect(points!.black[0]).toBeGreaterThan(0.25);
    expect(points!.black[0]).toBeCloseTo(0.3, 1);
  });

  it('ignores pillarbox bars too', () => {
    const points = framePoints(frame(64, 64, (x, y) => {
      if (x < 10 || x >= 54) return [0, 0, 0];
      const v = 0.3 + (y / 63) * 0.5;
      return [v, v, v];
    }));

    expect(points).not.toBeNull();
    expect(points!.black[0]).toBeGreaterThan(0.25);
  });

  it('declines a frame with no picture in it', () => {
    expect(framePoints(frame(32, 32, () => [0, 0, 0]))).toBeNull();
  });

  it('declines a sample it cannot trust', () => {
    expect(framePoints(null)).toBeNull();
    expect(framePoints(new Float32Array([0, 0]))).toBeNull();
    // A header promising more pixels than the buffer holds.
    const short = new Float32Array(20);
    short[0] = 64;
    short[1] = 64;
    expect(framePoints(short)).toBeNull();
  });
});

describe('auto balance', () => {
  const frame = (
    width: number,
    height: number,
    pixel: (x: number, y: number) => [number, number, number],
  ) => {
    const out = new Float32Array(width * height * 3 + 2);
    out[0] = width;
    out[1] = height;
    let o = 2;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [r, g, b] = pixel(x, y);
        out[o++] = r;
        out[o++] = g;
        out[o++] = b;
      }
    }
    return out;
  };

  /** A washed-out, blue-cast picture: floor at 0.12, ceiling at 0.7. */
  const flat = frame(64, 64, x => {
    const v = 0.12 + (x / 63) * 0.58;
    return [v * 0.94, v, Math.min(1, v * 1.1)];
  });

  it('takes both ends to the full range', () => {
    const solved = autoBalance(GRADE_NEUTRAL, flat);

    expect(solved).not.toBeNull();
    expect(solved!.solved).toEqual({ black: true, white: true });

    const points = framePoints(flat)!;
    gradePixel(points.black, solved!.values).forEach(v => expect(v).toBeCloseTo(0, 4));
    gradePixel(points.white, solved!.values).forEach(v => expect(v).toBeCloseTo(1, 4));
  });

  it('beats running the two pickers in sequence, in either order', () => {
    // The reason solveRamp exists. Lift and gain share one ramp, so each
    // picker solves against the other as it stands: black-then-white moves
    // the black that was just set, and white-then-black moves the white.
    // Neither sequence lands both ends; the joint solve lands both.
    const points = framePoints(flat)!;
    const joint = autoBalance(GRADE_NEUTRAL, flat)!;

    const blackFirst = solveWhitePoint(
      solveBlackPoint(GRADE_NEUTRAL, points.black)!.values, points.white,
    )!;
    const whiteFirst = solveBlackPoint(
      solveWhitePoint(GRADE_NEUTRAL, points.white)!.values, points.black,
    )!;

    const missBy = (values: GradeValues) =>
      Math.abs(gradePixel(points.black, values)[1] - 0)
      + Math.abs(gradePixel(points.white, values)[1] - 1);

    expect(missBy(joint.values)).toBeLessThan(1e-4);
    expect(missBy(blackFirst.values)).toBeGreaterThan(missBy(joint.values));
    expect(missBy(whiteFirst.values)).toBeGreaterThan(missBy(joint.values));
  });

  it('holds both ends through a cast, not just the level', () => {
    // A green-lit, blue-crushed frame: the two ends disagree about which way
    // the cast runs, which is exactly what a per-channel solve is for.
    const cast = frame(64, 64, x => {
      const v = x / 63;
      return [0.1 + v * 0.6, 0.16 + v * 0.68, 0.05 + v * 0.5];
    });
    const points = framePoints(cast)!;
    const solved = autoBalance(GRADE_NEUTRAL, cast)!;

    expect(solved.solved).toEqual({ black: true, white: true });
    gradePixel(points.black, solved.values).forEach(v => expect(v).toBeCloseTo(0, 4));
    gradePixel(points.white, solved.values).forEach(v => expect(v).toBeCloseTo(1, 4));
  });

  it('declines a frame too flat to solve, rather than answering with nonsense', () => {
    // Ends a tenth apart need a slope of 10 — past every control it would
    // have to be stored in. solveRamp stands down and the pickers take over.
    const points = framePoints(frame(64, 64, x => {
      const v = 0.4 + (x / 63) * 0.1;
      return [v, v, v];
    }))!;

    expect(solveRamp(GRADE_NEUTRAL, points.black, points.white)).toBeNull();
  });

  it('sets the end it can when the picture only offers one', () => {
    // Nothing below 0.8: there is no black to find, but there is a white.
    const bright = frame(64, 64, x => {
      const v = 0.8 + (x / 63) * 0.15;
      return [v, v, v];
    });

    const solved = autoBalance(GRADE_NEUTRAL, bright);

    expect(solved).not.toBeNull();
    expect(solved!.solved.black).toBe(false);
    expect(solved!.solved.white).toBe(true);
    expect(solved!.values.lift).toEqual(GRADE_NEUTRAL.lift);
  });

  it('declines a frame it cannot read', () => {
    expect(autoBalance(GRADE_NEUTRAL, null)).toBeNull();
  });

  it('stays well inside a frame budget on a full-size scope sample', () => {
    // The scope sample is 240px wide; this is the real size the button runs
    // on. It is a one-shot on click, not on the drag path, but a grader who
    // clicks it should not watch the window stall.
    const full = frame(240, 135, (x, y) => {
      const v = ((x * 7 + y * 13) % 100) / 120;
      return [v, v * 0.98, v * 1.02];
    });

    const started = performance.now();
    expect(autoBalance(GRADE_NEUTRAL, full)).not.toBeNull();
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe('trackball geometry', () => {
  it('round-trips a puck through channel values', () => {
    for (const { name } of BALL_SPECS) {
      for (const [x, y] of [[0, 0], [0.4, 0.3], [-0.7, 0.2], [0, -0.9]] as const) {
        const ball = puckToBall(name, x, y, name === 'lift' || name === 'offset' ? 0 : 1);
        const back = ballToPuck(name, ball);
        expect(back.x).toBeCloseTo(x, 10);
        expect(back.y).toBeCloseTo(y, 10);
      }
    }
  });

  it('pushes straight up as pure red, and stays chromatic', () => {
    const ball = puckToBall('gain', 0, 1, 1);
    expect(ball.r).toBeGreaterThan(1);
    expect(ball.g).toBeLessThan(1);
    expect(ball.b).toBeLessThan(1);
    // The three cosines sum to zero, so a ball never shifts overall level.
    expect(ball.r + ball.g + ball.b).toBeCloseTo(3, 10);
  });

  it('keeps a hand-edited .vkfilter inside the disc', () => {
    const puck = ballToPuck('lift', { r: 5, g: -5, b: 0, m: 0 });
    expect(Math.hypot(puck.x, puck.y)).toBeLessThanOrEqual(1 + 1e-9);
  });
});

/**
 * A postfix evaluator standing in for std.Expr. It checks that the expression
 * form the template builds is algebraically the same grade as the reference —
 * the mistake most likely to slip through is a reversed operand in RPN.
 */
function evaluateExpr(expression: string, x: number, y: number, z: number): number {
  const stack: number[] = [];
  for (const token of expression.trim().split(/\s+/)) {
    if (token === 'x') { stack.push(x); continue; }
    if (token === 'y') { stack.push(y); continue; }
    if (token === 'z') { stack.push(z); continue; }
    if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(token)) { stack.push(Number(token)); continue; }
    const b = stack.pop() as number;
    const a = stack.pop() as number;
    switch (token) {
      case '+': stack.push(a + b); break;
      case '-': stack.push(a - b); break;
      case '*': stack.push(a * b); break;
      case '/': stack.push(a / b); break;
      case 'max': stack.push(Math.max(a, b)); break;
      case 'min': stack.push(Math.min(a, b)); break;
      case 'pow': stack.push(Math.pow(a, b)); break;
      default: throw new Error(`unsupported Expr token: ${token}`);
    }
  }
  if (stack.length !== 1) throw new Error(`expression left ${stack.length} values on the stack`);
  return stack[0];
}

// Mirrors the string building in Color Grade.vkfilter. Kept beside the
// reference so a change to one fails loudly against the other.
function buildExpressions(values: GradeValues) {
  const terms = channelTerms(values);
  const f = (value: number) => value.toFixed(8);
  const channelExpr = (c: 'r' | 'g' | 'b') =>
    `x ${f(terms.offset[c])} + ${f(terms.gain[c] - terms.lift[c])} * ${f(terms.lift[c])} + ` +
    `0 max ${f(terms.invGamma[c])} pow ${f(values.pivot)} - ${f(values.contrast)} * ` +
    `${f(values.pivot)} + ${f(values.brightness)} + 0 max 1 min`;

  const angle = (values.hue * Math.PI) / 180;
  const cos = f(Math.cos(angle));
  const sin = f(Math.sin(angle));
  const sat = f(values.saturation);
  const Y = `x ${f(LUMA_R)} * y ${f(LUMA_G)} * + z ${f(LUMA_B)} * +`;
  const CR = `x ${Y} -`;
  const CB = `z ${Y} -`;
  const CRR = `${CB} ${sin} * ${CR} ${cos} * +`;
  const CBR = `${CB} ${cos} * ${CR} ${sin} * -`;

  return {
    channel: { r: channelExpr('r'), g: channelExpr('g'), b: channelExpr('b') },
    mixR: `${Y} ${CRR} ${sat} * + 0 max 1 min`,
    mixB: `${Y} ${CBR} ${sat} * + 0 max 1 min`,
    mixG: `${Y} ${CRR} ${f(LUMA_R)} * ${CBR} ${f(LUMA_B)} * + ${sat} * ${f(LUMA_G)} / - 0 max 1 min`,
  };
}

describe('the emitted VapourSynth expressions', () => {
  const pixels = [
    [0, 0, 0], [1, 1, 1], [0.5, 0.5, 0.5], [0.6, 0.4, 0.25], [0.05, 0.9, 0.33], [0.82, 0.12, 0.55],
  ] as const;

  for (const values of [GRADE_NEUTRAL, graded]) {
    const label = values === GRADE_NEUTRAL ? 'neutral' : 'a real grade';

    it(`match the reference for ${label}`, () => {
      const expressions = buildExpressions(values);
      for (const pixel of pixels) {
        const perChannel: [number, number, number] = [
          evaluateExpr(expressions.channel.r, pixel[0], 0, 0),
          evaluateExpr(expressions.channel.g, pixel[1], 0, 0),
          evaluateExpr(expressions.channel.b, pixel[2], 0, 0),
        ];
        const [r, g, b] = perChannel;
        const actual = [
          evaluateExpr(expressions.mixR, r, g, b),
          evaluateExpr(expressions.mixG, r, g, b),
          evaluateExpr(expressions.mixB, r, g, b),
        ];
        const expected = gradePixel(pixel, values);
        actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 6));
      }
    });
  }

  it('never emits scientific notation, which std.Expr cannot parse', () => {
    const tiny = { ...GRADE_NEUTRAL, brightness: 0.00000001, contrast: 1.00000002 };
    const expressions = buildExpressions(tiny);
    for (const expression of [expressions.channel.r, expressions.mixR, expressions.mixG]) {
      expect(expression).not.toMatch(/e[-+]\d/i);
    }
  });
});

describe('the Color Grade template', () => {
  it('declares every variable its code interpolates', () => {
    const template = loadTemplate();
    const referenced = new Set(
      [...template.code.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)].map(match => match[1]),
    );
    expect(referenced.size).toBeGreaterThan(0);
    for (const name of referenced) {
      expect(template.variables, `{{${name}}} has no [variables.${name}]`).toHaveProperty(name);
    }
  });

  it('wires every editor role to a declared variable', () => {
    const template = loadTemplate();
    expect(template.editor.type).toBe('colorGrade');

    const names: string[] = [];
    for (const { name } of BALL_SPECS) {
      const ball = template.editor.variables[name];
      expect(ball, `[editor.variables] is missing ${name}`).toHaveLength(4);
      names.push(...ball);
    }
    for (const { name } of SCALAR_SPECS) names.push(template.editor.variables[name]);

    for (const name of names) {
      expect(template.variables, `[editor.variables] points at undeclared ${name}`).toHaveProperty(name);
    }
    expect(new Set(names).size, 'a variable is wired to two roles').toBe(names.length);
  });

  it('defaults to a grade that does nothing', () => {
    const template = loadTemplate();
    const parameters = Object.fromEntries(
      Object.entries(template.variables).map(([name, spec]) => [name, spec.default as number]),
    );
    const values = gradeFromParameters(template.editor, parameters);
    expect(isNeutralGrade(values)).toBe(true);
    expect(values.pivot).toBeCloseTo(0.435, 6);
  });

  it('round-trips values through the template mapping', () => {
    const template = loadTemplate();
    const parameters = gradeToParameters(template.editor, graded);
    expect(gradeFromParameters(template.editor, parameters)).toEqual(graded);
  });
});
