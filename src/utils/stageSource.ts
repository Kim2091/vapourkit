// src/utils/stageSource.ts — what a step that reads another step's picture is
// pointed at, and whether that still works.
//
// One filter reaching outside its own input used to mean one name: original_clip,
// bound near the top of the generated script, moved by inserting a step whose
// whole job was to rebind it. A reference you set somewhere else in the list.
//
// A stage reference is the same idea with the indirection taken out. The step
// names another step by id, the generator keeps that step's picture, and the
// filter reads it. What is left over is everything an id can stop naming — a
// step deleted, turned off, dragged below, or sitting in the chain producing
// nothing — and that is what this file is: the same four answers the generator
// gives, worked out before anything runs so the card can say them first.
//
// The rules here mirror electron/scriptGenerator.ts deliberately. The script is
// the authority and refuses on its own; this is so nobody has to press render
// to find out.

import { stepLabel } from '../hooks/useChainPreview';
import { stepNumber } from './lutSteps';
import type { Filter } from '../electron.d';
import { parseReferenceVideo, type ReferenceVideo } from '../../electron/referenceVideo';

/**
 * Whether a step puts a picture into the chain at all.
 *
 * A model step with nothing chosen yet and a custom step with an empty body
 * both sit in the list looking like steps and emit no code whatsoever. Neither
 * can be read from, and an AI step with no model is not an edge case — it is
 * what every model step looks like for the minute before a model is picked.
 */
export function producesPicture(filter: Filter): boolean {
  return filter.filterType === 'aiModel'
    ? Boolean(filter.modelPath)
    : filter.code.trim().length > 0;
}

/** The step id a reference holds, or '' for the source. */
export function stageSourceId(filter: Filter, variable: string): string {
  return String(filter.parameters?.[variable] ?? '').trim();
}

/** What a step's reference is pointed at, and what is wrong with it. */
export type StageLink =
  /** Nothing named, which means the source — what the older filter always used. */
  | { state: 'source' }
  /** A separate video file rather than a step; see electron/referenceVideo.ts. */
  | { state: 'file'; video: ReferenceVideo }
  | { state: 'missing' }
  | { state: 'self' }
  | { state: 'disabled'; step: Filter; number: number; label: string }
  | { state: 'below'; step: Filter; number: number; label: string }
  /** In the chain and above, but emitting nothing to read. */
  | { state: 'silent'; step: Filter; number: number; label: string }
  | { state: 'ready'; step: Filter; number: number; label: string };

export function stageLink(filters: Filter[], reader: Filter, variable: string): StageLink {
  const id = stageSourceId(reader, variable);
  if (!id) return { state: 'source' };
  const video = parseReferenceVideo(id);
  if (video) return { state: 'file', video };
  if (id === reader.id) return { state: 'self' };

  const step = filters.find(filter => filter.id === id);
  if (!step) return { state: 'missing' };

  const at = { step, number: stepNumber(filters, id), label: stepLabel(step) };
  if (!step.enabled) return { state: 'disabled', ...at };
  // Order, not enabled position: the two agree for enabled steps, and this is
  // the order the person is looking at.
  if (step.order >= reader.order) return { state: 'below', ...at };
  if (!producesPicture(step)) return { state: 'silent', ...at };
  return { state: 'ready', ...at };
}

/**
 * The steps a reference could be pointed at: enabled, above, and actually
 * producing something.
 *
 * Offering only these is the cheapest guard there is — most of the broken
 * states above are only reachable by changing the chain after the choice was
 * made, never by making the choice.
 */
export function stagesAbove(filters: Filter[], reader: Filter): Filter[] {
  return [...filters]
    .sort((a, b) => a.order - b.order)
    .filter(filter => filter.enabled && filter.order < reader.order && producesPicture(filter));
}
