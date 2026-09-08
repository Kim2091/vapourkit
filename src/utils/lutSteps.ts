// src/utils/lutSteps.ts — what the chain's two LUT steps mean, read off the
// chain itself.
//
// A table is a transform between two pictures, and the first design asked for
// both of them: a Create LUT step was one end, its editor named the other, and
// a direction said which way round. Nobody could work it. Someone putting a
// Create LUT before an upscaler is not thinking about pairs; they are thinking
// "remember what it looks like here", and there was no way to say that.
//
// So the pair is never asked for. It is read off where the two steps sit:
//
//   Create LUT   remembers the colour at its position. It does nothing else.
//
//   Load LUT     pointed at a Create LUT above it, puts that colour back. The
//                table reads the picture arriving at the Load LUT and writes
//                the colour the Create LUT saw. Both ends are the two steps'
//                own positions, and the direction is always the same one,
//                because "restore" only ever means one thing.
//
// The other table — what the chain does to colour up to a point — is the
// Create LUT's own to save as a file, from the source to itself. It is never
// a step in the chain, because applying it inside the chain that made it
// would do everything twice.
//
// Everything here is a pure function of the filter list, so the card in the
// filter panel and the hook that generates read the same answer, with no
// preview session open.

import { planBetween, type StepPlan } from './chainLut';
import { stepLabels } from '../hooks/useChainPreview';
import type { SkippedStep } from './lut';
import type { Filter } from '../electron.d';

export const CREATE_LUT = 'Create LUT';

/** Filters that apply a table, including the name that filter used to have. */
export const LOADS_LUT = new Set(['Load LUT', 'Apply LUT']);

export const isMarker = (filter: Filter) => filter.preset === CREATE_LUT;
export const isLoader = (filter: Filter) => LOADS_LUT.has(filter.preset || '');

const enabledInOrder = (filters: Filter[]) =>
  filters.filter(filter => filter.enabled).sort((a, b) => a.order - b.order);

/**
 * The number the filter panel prints beside a step.
 *
 * Its place in the whole list, disabled steps included, because that is the
 * number the person is looking at. Output indices skip disabled steps and are
 * for the preview to count, not for anyone to read.
 */
export function stepNumber(filters: Filter[], id: string): number {
  const at = [...filters].sort((a, b) => a.order - b.order).findIndex(filter => filter.id === id);
  return at < 0 ? 0 : at + 1;
}

/**
 * The preview output that is a step's own picture, or -1 when the step is
 * disabled or gone.
 *
 * One per enabled filter in chain order, after the source at 0. A Create LUT
 * emits one too — its picture is the picture arriving at it, because it does
 * nothing — so for a marker this is also the output it remembers.
 */
export function outputOf(filters: Filter[], id: string): number {
  const at = enabledInOrder(filters).findIndex(filter => filter.id === id);
  return at < 0 ? -1 : at + 1;
}

/**
 * Where a Create LUT sits, in words: "before DLSS Neural Uplift", or "at the
 * end of the chain".
 *
 * Named by what follows it rather than by what precedes it, because that is
 * what the marker is for — the thing about to change the colour is the thing
 * it is placed to get back from. Other markers are looked past, so two of
 * them in a row are both "before" the same step and tell apart by number.
 */
export function markerPlace(filters: Filter[], id: string): string {
  const enabled = enabledInOrder(filters);
  const at = enabled.findIndex(filter => filter.id === id);
  if (at < 0) return 'disabled';
  const labels = stepLabels(filters);
  for (let next = at + 1; next < enabled.length; next++) {
    if (!isMarker(enabled[next])) return `before ${labels[next + 1]}`;
  }
  return 'at the end of the chain';
}

/** How a span of the chain would be answered, decided before anything runs. */
export type LutMethod =
  | { kind: 'solve'; captured: string[] }
  | { kind: 'measure'; because: SkippedStep }
  /** Nothing sits in the span, so there is no transform to describe. */
  | { kind: 'nothing' };

/**
 * Read a plan for which engine it needs, without any table off disk.
 *
 * A Load LUT whose file has not been read yet is a step the plan cannot
 * finish, but it is still a modelled one — counting it as unmodelled here
 * would tell someone their chain has to be measured and then quietly solve
 * it a moment later.
 */
export function methodFor(plan: StepPlan[]): LutMethod {
  const unmodelled = plan.find(step => step.skip);
  if (unmodelled?.skip) return { kind: 'measure', because: unmodelled.skip };
  if (plan.length === 0) return { kind: 'nothing' };
  return { kind: 'solve', captured: plan.map(step => step.label) };
}

/**
 * What a Load LUT step is pointed at, and whether that can be restored.
 *
 * `from` is the picture arriving at the Load LUT and `to` is the marker's,
 * in preview output numbers: the table is measured from `from` to `to`, or
 * solved as the inverse of the steps between them. The wrong-way case — a
 * marker below the Load LUT — is refused by name rather than solved forwards,
 * because that table would be the chain's own colour work applied a second
 * time, which nobody putting a Load LUT in a chain means.
 */
export type RestoreLink =
  | { state: 'none' }
  /** This Load LUT is disabled, so it has no input to correct. */
  | { state: 'off' }
  /** The step it was following is no longer in the chain. */
  | { state: 'missing' }
  | { state: 'disabled'; marker: Filter; number: number }
  | { state: 'below'; marker: Filter; number: number }
  | {
    state: 'ready';
    marker: Filter;
    number: number;
    place: string;
    from: number;
    to: number;
    method: LutMethod;
  };

export function restoreLink(filters: Filter[], loader: Filter): RestoreLink {
  const sourceId = String(loader.parameters?.source_id ?? '');
  if (!sourceId) return { state: 'none' };

  const marker = filters.find(filter => filter.id === sourceId) ?? null;
  if (!marker || !isMarker(marker)) return { state: 'missing' };

  const number = stepNumber(filters, marker.id);
  if (!marker.enabled) return { state: 'disabled', marker, number };

  const own = outputOf(filters, loader.id);
  if (own < 0) return { state: 'off' };
  const from = own - 1;
  const to = outputOf(filters, marker.id);
  if (to > from) return { state: 'below', marker, number };

  return {
    state: 'ready',
    marker,
    number,
    place: markerPlace(filters, marker.id),
    from,
    to,
    method: methodFor(planBetween(filters, to, from, new Map())),
  };
}

/** The chain above a Create LUT, as the table it could be saved as. */
export function bakeSpan(filters: Filter[], marker: Filter): { to: number; method: LutMethod } | null {
  const to = outputOf(filters, marker.id);
  if (to < 0) return null;
  return { to, method: methodFor(planBetween(filters, 0, to, new Map())) };
}

/**
 * What a restore table depended on.
 *
 * Everything that would change the answer: which marker, how finely it was
 * sampled, and every step between the two. Stored beside the table so the
 * Load LUT can say when the chain has moved out from under it — a step
 * applying yesterday's restore is the quiet failure this exists to catch.
 */
export function restoreFingerprint(
  filters: Filter[],
  link: Extract<RestoreLink, { state: 'ready' }>,
  size: number,
): string {
  const between = enabledInOrder(filters).slice(link.to, link.from).map(filter => ({
    p: filter.preset,
    c: filter.code,
    m: filter.modelPath,
    v: filter.parameters ?? null,
  }));
  return JSON.stringify({ marker: link.marker.id, size, between });
}

/** Create LUT steps a Load LUT could restore to: enabled, and above it. */
export function markersAbove(filters: Filter[], loader: Filter): Filter[] {
  const enabled = enabledInOrder(filters);
  const at = enabled.findIndex(filter => filter.id === loader.id);
  const above = at < 0 ? enabled : enabled.slice(0, at);
  return above.filter(isMarker);
}

/** Load LUT steps in the chain that restore a given marker. */
export function loadersOf(filters: Filter[], markerId: string): Filter[] {
  return [...filters]
    .sort((a, b) => a.order - b.order)
    .filter(filter => isLoader(filter) && String(filter.parameters?.source_id ?? '') === markerId);
}
