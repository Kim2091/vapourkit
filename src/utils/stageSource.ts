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
import type { Filter } from '../electron.d';
import type { ReferenceVideo } from '../../electron/referenceVideo';
import {
  producesPicture as graphProducesPicture,
  readableFrom,
  resolveReference,
  sideChainLabel,
  sideChainLetter,
  layoutChains,
  stepTag,
  type Chain,
} from '../../electron/chainGraph';

/** Whether a step puts a picture into the chain at all; see chainGraph.ts. */
export function producesPicture(filter: Filter): boolean {
  return graphProducesPicture(filter);
}

/** The step id a reference holds, or '' for the source. */
export function stageSourceId(filter: Filter, variable: string): string {
  return String(filter.parameters?.[variable] ?? '').trim();
}

/** A step, as the card names it: its tag in the rail ("3", "A2") and its label. */
interface Named { step: Filter; tag: string; label: string }

/** A side chain, as the card names it: its letter and its label. */
interface NamedChain { chain: Chain<Filter>; letter: string; label: string }

/**
 * What a step's reference is pointed at, and what is wrong with it. The rules
 * are chainGraph.resolveReference's; this only adds the names the card prints.
 */
export type StageLink =
  /** Nothing named: the source of the reader's own chain, before any filter. */
  | { state: 'source' }
  /** A separate video file rather than a step; see electron/referenceVideo.ts. */
  | { state: 'file'; video: ReferenceVideo }
  | ({ state: 'chain' } & NamedChain)
  | ({ state: 'chainOff' } & NamedChain)
  | ({ state: 'chainLoop' } & NamedChain)
  | { state: 'missing' }
  | { state: 'self' }
  | ({ state: 'otherChain' } & Named)
  | ({ state: 'disabled' } & Named)
  | ({ state: 'below' } & Named)
  /** In the chain and above, but emitting nothing to read. */
  | ({ state: 'silent' } & Named)
  | ({ state: 'ready' } & Named);

export function nameChain(filters: Filter[], chain: Chain<Filter>): NamedChain {
  const at = layoutChains(filters).side.findIndex(candidate => candidate.id === chain.id);
  return { chain, letter: sideChainLetter(Math.max(at, 0)), label: sideChainLabel(chain) };
}

export function nameStep(filters: Filter[], step: Filter): Named {
  return { step, tag: stepTag(filters, step.id), label: stepLabel(step) };
}

export function stageLink(filters: Filter[], reader: Filter, variable: string): StageLink {
  const reference = resolveReference(filters, reader, stageSourceId(reader, variable));
  switch (reference.state) {
    case 'source':
    case 'file':
    case 'missing':
    case 'self':
      return reference;
    case 'chain':
    case 'chainOff':
    case 'chainLoop':
      return { state: reference.state, ...nameChain(filters, reference.chain) };
    default:
      return { state: reference.state, ...nameStep(filters, reference.step) };
  }
}

/**
 * What a reference could be pointed at: steps above the reader in its own
 * chain that produce a picture, and the side chains it may read.
 *
 * Offering only these is the cheapest guard there is — most of the broken
 * states above are only reachable by changing the chain after the choice was
 * made, never by making the choice.
 */
export function stagesAbove(filters: Filter[], reader: Filter): Filter[] {
  return readableFrom(filters, reader).steps;
}

export function chainsReadable(filters: Filter[], reader: Filter): Chain<Filter>[] {
  return readableFrom(filters, reader).chains;
}
