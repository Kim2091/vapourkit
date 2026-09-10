// src/utils/stepReferences.ts — keeping a reference to a step pointed at that
// step when every id in the chain is replaced at once.
//
// Two features now have a step name another step by id: a Load LUT puts back
// the colour a Create LUT remembered, and a Wavelet Color Fix from Step reads
// the picture at whatever step it names. An id is the right thing to store —
// it is the only handle that survives dragging and inserting — but it is only
// as good as the ids around it, and importing a workflow assigns fresh ones to
// every filter it loads.
//
// So the ids have to be carried across the swap. What lands here is the map
// from what a filter's id was in the file to what it is now, and every stored
// value that was one of those ids becomes the other. Nothing else is touched:
// a parameter only counts as a reference if it is exactly an id the same
// workflow just handed out, which a path or a name never is.

import type { Filter } from '../electron.d';

/**
 * Rewrite every stored reference through a map of old id to new id.
 *
 * A value naming an id the file did not contain is left as it was, and comes
 * out the other side as the "no longer in the chain" the cards already say —
 * quietly repointing it at whatever happens to sit in that slot now would be
 * the worse failure by a distance.
 */
export function remapStepReferences(filters: Filter[], byOldId: Map<string, string>): Filter[] {
  if (byOldId.size === 0) return filters;

  return filters.map(filter => {
    if (!filter.parameters) return filter;

    let changed = false;
    const parameters = Object.fromEntries(
      Object.entries(filter.parameters).map(([name, value]) => {
        const moved = typeof value === 'string' ? byOldId.get(value) : undefined;
        if (moved === undefined) return [name, value];
        changed = true;
        return [name, moved];
      }),
    );
    return changed ? { ...filter, parameters } : filter;
  });
}
