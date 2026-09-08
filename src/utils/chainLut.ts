// src/utils/chainLut.ts — what the chain does to colour between two steps.
//
// Resolve generates a 3D LUT from a clip by evaluating its node graph over a
// lattice. This is the same thing for a Vapourkit chain, at any step: walk the
// lattice through every colour operation up to that step and write down where
// each entry lands.
//
// A table is a transform, though, and a transform has two ends. One step alone
// gives you half a row — "the source's colour" is not a function, it is a
// picture — so everything here is planned as a *pair* of outputs with the
// steps between them. (0 → n) is the forward bake the rail has always offered;
// (n → 0) is the same composition run backwards, which is how the colour at
// the end of a chain is put back where the source's was.
//
// The honest part is what it refuses. A LUT is a function of one pixel, so it
// can only describe operations that are functions of one pixel. CAS Sharpen
// reads a pixel's neighbours; an upscaler invents them. There is no table that
// describes either, and a bake that quietly skipped them would hand back a
// table claiming to be a stage it is not. So every step is classified, and the
// ones that cannot be captured come back named for the caller to show.

import { gradeFromParameters, gradePixel } from './colorGrade';
import { parseLut, sampleLut, to3d, type ColorOperation, type SkippedStep } from './lut';
import type { Filter } from '../electron.d';

/** How a filter is read, decided by what Vapourkit knows it to be. */
export interface StepPlan {
  label: string;
  /** Set when this step composes into the table. */
  apply?: ColorOperation;
  /** Set instead when it cannot, with the reason to show. */
  skip?: SkippedStep;
  /** A LUT file this step needs read before the plan is usable. */
  pendingLutPath?: string;
}

/**
 * Filters whose colour effect Vapourkit can evaluate itself.
 *
 * Keyed by template name rather than by the "Color Modification" category. The
 * category says a filter changes colour; it does not say Vapourkit has a model
 * of *how*, and a category match alone would let a hand-written template be
 * baked as whatever the baker guessed. A name is a promise about the code.
 */
const MODELLED = new Set(['Color Grade', 'Load LUT', 'Apply LUT']);

/**
 * Steps that do nothing to the picture, and so contribute nothing to a table.
 *
 * Create LUT is a marker: it takes a position in the chain and generates a
 * file, and the frames pass through it untouched. Left unlisted it would fall
 * through to "no colour model for this filter" and force every pair spanning
 * it to be measured — which would mean adding a LUT maker to a chain changed
 * how every other LUT in that chain was made.
 */
const TRANSPARENT = new Set(['Create LUT']);

/** Filters that are known not to be per-pixel, so the reason can be specific. */
const SPATIAL_REASON: Record<string, string> = {
  'CAS Sharpen': 'sharpening reads each pixel’s neighbours, so no table can describe it',
  'Shift Chroma': 'this moves pixels rather than recolouring them',
};

const isResize = (name: string) => name.startsWith('Resize');

/**
 * How one step reads: an operation to compose, or a reason it cannot be.
 */
function planStep(filter: Filter, lutTables: Map<string, string>): StepPlan {
  // `preset` is the template's name; a custom filter has none, and an AI
  // model step is labelled by its model. Matching the rail's own labels
  // matters, because the reasons below name steps back to the user.
  const template = filter.preset || '';
  const label = filter.filterType === 'aiModel' && filter.modelPath
    ? (filter.modelPath.split(/[\\/]/).pop() ?? 'Model').replace(/\.[^.]+$/, '')
    : template || 'Custom filter';

  if (template === 'Color Grade') {
    const editor = filter.editor?.type === 'colorGrade' ? filter.editor : null;
    if (!editor) {
      return { label, skip: { label, reason: 'this grade has no editor to read its values from' } };
    }
    const values = gradeFromParameters(editor, filter.parameters);
    return { label, apply: (rgb) => gradePixel(rgb, values) };
  }

  if (template === 'Load LUT' || template === 'Apply LUT') {
    const path = String(filter.parameters?.lut_path ?? '').trim();
    if (!path) {
      return { label, skip: { label, reason: 'no table is loaded into it' } };
    }
    const text = lutTables.get(path);
    if (text === undefined) return { label, pendingLutPath: path };
    try {
      const table = to3d(parseLut(text, path));
      const strength = Number(filter.parameters?.strength ?? 1);
      const mix = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 1;
      return {
        label,
        apply: (rgb) => {
          const out = sampleLut(table, rgb);
          if (mix >= 1) return out;
          // The filter blends towards the untouched picture at strength < 1,
          // and a table that ignored that would not be the step it claims.
          return [
            rgb[0] + (out[0] - rgb[0]) * mix,
            rgb[1] + (out[1] - rgb[1]) * mix,
            rgb[2] + (out[2] - rgb[2]) * mix,
          ];
        },
      };
    } catch (error) {
      return {
        label,
        skip: { label, reason: `its table could not be read — ${error instanceof Error ? error.message : String(error)}` },
      };
    }
  }

  if (SPATIAL_REASON[template]) {
    return { label, skip: { label, reason: SPATIAL_REASON[template] } };
  }
  if (isResize(template)) {
    return { label, skip: { label, reason: 'resizing changes where pixels are, not what colour they are' } };
  }
  if (filter.modelPath) {
    return { label, skip: { label, reason: 'a neural upscaler invents pixels, so no table can describe it' } };
  }
  return {
    label,
    skip: {
      label,
      reason: MODELLED.has(template)
        ? 'this step could not be read'
        : 'Vapourkit has no colour model for this filter, so it cannot be evaluated over a lattice',
    },
  };
}

/**
 * Work out what each step between two outputs contributes.
 *
 * A table is never about one step. It is about the transform sitting between a
 * pair of them: `from` is the picture going in, `to` is the picture coming out,
 * and what is planned here is everything in the way. Output indices match the
 * preview session's — 0 is the untouched source, and the filter at position p
 * produces output p + 1 — so the steps between outputs A and B are the enabled
 * filters at positions A through B - 1.
 *
 * The pair is read unordered. Which direction the caller wants it in is a
 * question about what to do with the plan, not about which steps are in it:
 * running it backwards means inverting the same composition, so asking for
 * (4 → 0) has to name exactly the steps (0 → 4) names.
 */
export function planBetween(
  filters: Filter[],
  fromIndex: number,
  toIndex: number,
  lutTables: Map<string, string>,
): StepPlan[] {
  const enabled = filters.filter(filter => filter.enabled).sort((a, b) => a.order - b.order);
  const low = Math.max(0, Math.min(fromIndex, toIndex));
  const high = Math.min(enabled.length, Math.max(fromIndex, toIndex));

  return enabled.slice(low, high)
    .filter(filter => !TRANSPARENT.has(filter.preset || ''))
    .map(filter => planStep(filter, lutTables));
}

/**
 * The pair that starts at the source, which is what a forward bake always is.
 *
 * Kept as its own name because "everything up to here" is how the rail's bake
 * reads to the person using it, and spelling the 0 at every call site would
 * make the common case look like the general one.
 */
export function planChainBake(
  filters: Filter[],
  throughIndex: number,
  lutTables: Map<string, string>,
): StepPlan[] {
  return planBetween(filters, 0, throughIndex, lutTables);
}

/** Paths the plan still needs read before it can be baked. */
export function pendingLutPaths(plan: StepPlan[]): string[] {
  return plan.map(step => step.pendingLutPath).filter((path): path is string => Boolean(path));
}

/** Split a resolved plan into what composes and what has to be reported. */
export function splitPlan(plan: StepPlan[]): {
  operations: { label: string; apply: ColorOperation }[];
  skipped: SkippedStep[];
} {
  const operations: { label: string; apply: ColorOperation }[] = [];
  const skipped: SkippedStep[] = [];
  for (const step of plan) {
    if (step.apply) operations.push({ label: step.label, apply: step.apply });
    else if (step.skip) skipped.push(step.skip);
    else if (step.pendingLutPath) {
      skipped.push({ label: step.label, reason: 'its table could not be loaded' });
    }
  }
  return { operations, skipped };
}
