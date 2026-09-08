// What a stage of the chain bakes into, and — the part that matters — what it
// refuses to. A table that quietly dropped a step would claim to be a stage it
// is not, so every exclusion is asserted here by name.

import { describe, it, expect } from 'vitest';
import { planBetween, planChainBake, pendingLutPaths, splitPlan } from './chainLut';
import { bakeChainToLut, sampleLut, writeCube, parseCube } from './lut';
import { GRADE_NEUTRAL, gradePixel, gradeToParameters } from './colorGrade';
import type { Filter, ColorGradeFilterEditor } from '../electron.d';

/** The editor block a Color Grade template declares, as the dock reads it. */
const GRADE_EDITOR: ColorGradeFilterEditor = {
  type: 'colorGrade',
  variables: {
    lift: ['lift_r', 'lift_g', 'lift_b', 'lift_m'],
    gamma: ['gamma_r', 'gamma_g', 'gamma_b', 'gamma_m'],
    gain: ['gain_r', 'gain_g', 'gain_b', 'gain_m'],
    offset: ['offset_r', 'offset_g', 'offset_b', 'offset_m'],
    temperature: 'temperature',
    tint: 'tint',
    contrast: 'contrast',
    pivot: 'pivot',
    saturation: 'saturation',
    hue: 'hue',
    brightness: 'brightness',
  },
};

let order = 0;
const filter = (over: Partial<Filter>): Filter => ({
  id: `f${++order}`,
  enabled: true,
  filterType: 'custom',
  preset: '',
  code: '',
  order,
  ...over,
});

const gradeFilter = (values = GRADE_NEUTRAL, over: Partial<Filter> = {}) => filter({
  preset: 'Color Grade',
  editor: GRADE_EDITOR,
  parameters: gradeToParameters(GRADE_EDITOR, values),
  ...over,
});

describe('planning a stage bake', () => {
  it('captures a Color Grade as the grade it holds', () => {
    const look = { ...GRADE_NEUTRAL, contrast: 1.2, saturation: 0.8, temperature: 900 };
    const plan = planChainBake([gradeFilter(look)], 1, new Map());
    const { operations, skipped } = splitPlan(plan);

    expect(skipped).toEqual([]);
    expect(operations).toHaveLength(1);
    // The captured operation has to BE the grade, not something like it.
    for (const probe of [[0.2, 0.4, 0.6], [0.9, 0.1, 0.5], [0, 0, 0]] as const) {
      const got = operations[0].apply(probe);
      gradePixel(probe, look).forEach((want, i) => expect(got[i]).toBeCloseTo(want, 9));
    }
  });

  it('refuses what is not a function of one pixel, and says which', () => {
    const plan = planChainBake([
      gradeFilter(),
      filter({ preset: 'CAS Sharpen' }),
      filter({ preset: 'Resize (px)' }),
      filter({ filterType: 'aiModel', modelPath: 'C:/models/2x_AniSD.onnx' }),
    ], 4, new Map());
    const { operations, skipped } = splitPlan(plan);

    expect(operations.map(o => o.label)).toEqual(['Color Grade']);
    expect(skipped.map(s => s.label)).toEqual(['CAS Sharpen', 'Resize (px)', '2x_AniSD']);
    expect(skipped[0].reason).toMatch(/neighbours/);
    expect(skipped[2].reason).toMatch(/invents pixels/);
  });

  it('stops at the step asked for', () => {
    const chain = [gradeFilter(), filter({ preset: 'CAS Sharpen' }), gradeFilter()];
    // Output 1 is the first filter's own picture, so only that one is in it.
    expect(splitPlan(planChainBake(chain, 1, new Map())).operations).toHaveLength(1);
    expect(splitPlan(planChainBake(chain, 3, new Map())).operations).toHaveLength(2);
    // Output 0 is the untouched source: nothing has happened to it yet.
    expect(planChainBake(chain, 0, new Map())).toEqual([]);
  });

  it('skips disabled steps and reads the rest in chain order', () => {
    const plan = planChainBake([
      filter({ preset: 'CAS Sharpen', order: 2 }),
      gradeFilter(GRADE_NEUTRAL, { order: 1 }),
      filter({ preset: 'Apply LUT', enabled: false, order: 0 }),
    ], 3, new Map());

    expect(plan.map(step => step.label)).toEqual(['Color Grade', 'CAS Sharpen']);
  });

  it('asks for an Apply LUT table before it can plan around one', () => {
    const chain = [filter({ preset: 'Apply LUT', parameters: { lut_path: 'C:/looks/warm.cube', strength: 1 } })];

    const first = planChainBake(chain, 1, new Map());
    expect(pendingLutPaths(first)).toEqual(['C:/looks/warm.cube']);

    // A table that darkens everything by a fifth.
    const table = writeCube({
      kind: '3d', size: 2, domainMin: [0, 0, 0], domainMax: [1, 1, 1],
      data: new Float32Array([
        0, 0, 0, 0.8, 0, 0, 0, 0.8, 0, 0.8, 0.8, 0,
        0, 0, 0.8, 0.8, 0, 0.8, 0, 0.8, 0.8, 0.8, 0.8, 0.8,
      ]),
    });
    const second = planChainBake(chain, 1, new Map([['C:/looks/warm.cube', table]]));
    const { operations, skipped } = splitPlan(second);

    expect(skipped).toEqual([]);
    const got = operations[0].apply([1, 1, 1]);
    got.forEach(value => expect(value).toBeCloseTo(0.8, 5));
  });

  it('honours an Apply LUT that is only partly mixed in', () => {
    const table = writeCube({
      kind: '3d', size: 2, domainMin: [0, 0, 0], domainMax: [1, 1, 1],
      data: new Float32Array([
        0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0,
        0, 0, 1, 1, 0, 1, 0, 1, 1, 0, 0, 0,
      ]),
    });
    const chain = [filter({ preset: 'Apply LUT', parameters: { lut_path: 'x.cube', strength: 0.5 } })];
    const plan = planChainBake(chain, 1, new Map([['x.cube', table]]));
    const { operations } = splitPlan(plan);

    // White maps to black in that table, so half strength lands halfway.
    operations[0].apply([1, 1, 1]).forEach(value => expect(value).toBeCloseTo(0.5, 5));
  });

  it('will not bake an Apply LUT with nothing loaded into it', () => {
    const plan = planChainBake([filter({ preset: 'Apply LUT', parameters: { lut_path: '  ' } })], 1, new Map());
    expect(splitPlan(plan).skipped[0].reason).toMatch(/no table is loaded/);
  });
});

describe('planning a pair of steps', () => {
  const chain = () => [
    gradeFilter({ ...GRADE_NEUTRAL, contrast: 1.2 }, { order: 0 }),
    filter({ preset: 'CAS Sharpen', order: 1 }),
    gradeFilter({ ...GRADE_NEUTRAL, saturation: 0.6 }, { order: 2 }),
    filter({ preset: 'Resize (px)', order: 3 }),
  ];

  it('takes only the steps that sit between the two outputs', () => {
    // Outputs 1..3 are produced by the filters at positions 1 and 2, so the
    // grade at position 0 is upstream of the pair and must not be in it.
    const plan = planBetween(chain(), 1, 3, new Map());
    expect(plan.map(step => step.label)).toEqual(['CAS Sharpen', 'Color Grade']);
  });

  it('names the same steps whichever way round the pair is asked for', () => {
    const forward = planBetween(chain(), 0, 3, new Map()).map(step => step.label);
    const backward = planBetween(chain(), 3, 0, new Map()).map(step => step.label);
    expect(backward).toEqual(forward);
  });

  it('is empty for a step paired with itself', () => {
    expect(planBetween(chain(), 2, 2, new Map())).toEqual([]);
  });

  it('is the forward bake when the pair starts at the source', () => {
    const pair = planBetween(chain(), 0, 3, new Map()).map(step => step.label);
    expect(planChainBake(chain(), 3, new Map()).map(step => step.label)).toEqual(pair);
  });

  it('reads a Create LUT step as though it were not there', () => {
    // It is a marker, not a picture step. Counted as unmodelled it would force
    // every pair spanning it to be measured, which would mean that adding a
    // LUT maker to a chain changed how every other LUT in that chain was made.
    const withMarker = [
      gradeFilter({ ...GRADE_NEUTRAL, contrast: 1.2 }, { order: 0 }),
      filter({ preset: 'Create LUT', order: 1, parameters: { lut_path: '', direction: 'restore' } }),
      gradeFilter({ ...GRADE_NEUTRAL, saturation: 0.6 }, { order: 2 }),
    ];
    const plan = planBetween(withMarker, 0, 3, new Map());

    expect(plan.map(step => step.label)).toEqual(['Color Grade', 'Color Grade']);
    expect(splitPlan(plan).skipped).toEqual([]);
  });

  it('reads a Load LUT step, and still reads the name it used to have', () => {
    const table = writeCube({
      kind: '3d', size: 2, domainMin: [0, 0, 0], domainMax: [1, 1, 1],
      data: new Float32Array([
        0, 0, 0, 0.5, 0, 0, 0, 0.5, 0, 0.5, 0.5, 0,
        0, 0, 0.5, 0.5, 0, 0.5, 0, 0.5, 0.5, 0.5, 0.5, 0.5,
      ]),
    });
    const tables = new Map([['t.cube', table]]);
    for (const preset of ['Load LUT', 'Apply LUT']) {
      const plan = planBetween(
        [filter({ preset, parameters: { lut_path: 't.cube', strength: 1 } })], 0, 1, tables);
      const { operations, skipped } = splitPlan(plan);
      expect(skipped).toEqual([]);
      operations[0].apply([1, 1, 1]).forEach(value => expect(value).toBeCloseTo(0.5, 5));
    }
  });

  it('clamps a pair that runs off either end of the chain', () => {
    const plan = planBetween(chain(), -4, 99, new Map());
    expect(plan).toHaveLength(4);
  });
});

describe('baking a stage', () => {
  it('composes the operations in order, once per lattice cell', () => {
    const first = { ...GRADE_NEUTRAL, contrast: 1.3 };
    const second = { ...GRADE_NEUTRAL, saturation: 0.5, temperature: -1200 };

    const baked = bakeChainToLut([
      { label: 'A', apply: (rgb) => gradePixel(rgb, first) },
      { label: 'B', apply: (rgb) => gradePixel(rgb, second) },
    ], [], 33, 'test');

    expect(baked.captured).toEqual(['A', 'B']);
    // The table has to agree with running the two grades back to back. What
    // separates them is the lattice, not the composition: src/utils/lut.test.ts
    // measures a 2.9/255 worst-channel error at size 33, so the budget here is
    // that and nothing more. A composition bug would blow straight through it.
    const LATTICE_BUDGET = 3 / 255;
    for (const probe of [[0.25, 0.5, 0.75], [0.1, 0.1, 0.1], [0.6, 0.3, 0.9]] as const) {
      const through = gradePixel(gradePixel(probe, first), second);
      sampleLut(baked.lut, probe).forEach((got, i) =>
        expect(Math.abs(got - through[i])).toBeLessThan(LATTICE_BUDGET));
    }
  });

  it('composes in the order given, not the other way round', () => {
    // Two operations that do not commute, so an order slip cannot pass.
    const lift = { ...GRADE_NEUTRAL, lift: { r: 0, g: 0, b: 0, m: 0.2 } };
    const crush = { ...GRADE_NEUTRAL, contrast: 1.8 };

    const forward = bakeChainToLut([
      { label: 'lift', apply: (rgb) => gradePixel(rgb, lift) },
      { label: 'crush', apply: (rgb) => gradePixel(rgb, crush) },
    ], [], 33);
    const probe: [number, number, number] = [0.3, 0.3, 0.3];

    const rightWay = gradePixel(gradePixel(probe, lift), crush);
    const wrongWay = gradePixel(gradePixel(probe, crush), lift);
    expect(Math.abs(rightWay[0] - wrongWay[0])).toBeGreaterThan(0.05);

    const got = sampleLut(forward.lut, probe)[0];
    expect(Math.abs(got - rightWay[0])).toBeLessThan(3 / 255);
  });

  it('carries the skipped steps through to the caller', () => {
    const baked = bakeChainToLut(
      [{ label: 'Color Grade', apply: (rgb) => [...rgb] as [number, number, number] }],
      [{ label: 'CAS Sharpen', reason: 'reads neighbours' }],
      17,
    );
    expect(baked.skipped).toEqual([{ label: 'CAS Sharpen', reason: 'reads neighbours' }]);
  });

  it('writes a cube that reads back as what was baked', () => {
    const look = { ...GRADE_NEUTRAL, gain: { r: 1.1, g: 1, b: 0.9, m: 1 }, contrast: 1.15 };
    const baked = bakeChainToLut([{ label: 'Color Grade', apply: (rgb) => gradePixel(rgb, look) }], [], 33);

    const round = parseCube(writeCube(baked.lut, 'round trip'));
    for (const probe of [[0.2, 0.5, 0.8], [0.45, 0.45, 0.45]] as const) {
      const want = sampleLut(baked.lut, probe);
      sampleLut(round, probe).forEach((got, i) => expect(got).toBeCloseTo(want[i], 4));
    }
  });

  it('refuses a size no table format can hold', () => {
    expect(() => bakeChainToLut([], [], 1)).toThrow();
    expect(() => bakeChainToLut([], [], 4.5)).toThrow();
  });
});
