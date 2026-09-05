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
