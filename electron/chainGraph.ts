// electron/chainGraph.ts — what the steps of a chain read from, worked out once.
//
// The list of steps the person edits is linear, and stays that way. Underneath
// it is a graph: every step reads the picture from the step above it in its
// own chain, and some steps also read a second picture by name — the source,
// an earlier step, another video, or a side chain. This file is the only
// place that turns the flat list into that graph and decides which of those
// readings are possible. The card answers from it before anything runs; the
// generator emits from it; neither keeps rules of its own that could drift.
//
// A side chain is a second, shorter list. Its first step is a Load Video
// (filterType 'videoSource'), whose id is also the chain's id; the steps in
// it carry that id in `chain`. Everything without a `chain` belongs to the
// main chain, which is what every workflow saved before side chains holds.
//
// The structures allowed here are exactly the ones the linear rail can show
// and edit, and no others. One level of side chains. Every step has one main
// input, the step above it in its own chain. A named input may point at an
// earlier step of the same chain, or at a whole side chain — never into the
// middle of another chain, and never at a side chain that starts below the
// reader's own, which is what keeps the graph free of cycles without a
// separate check.
//
// Pure, so the renderer's card and the generator read it the same way.

import { parseReferenceVideo, type ReferenceVideo } from './referenceVideo';

export type StepKind = 'aiModel' | 'custom' | 'videoSource';

/**
 * How a Load Video's file lines up with the main source, as include/
 * align_videos.py measured it: reference time = speed × main time + the
 * offset of the section that main time falls in. Sections exist because two
 * releases are not always the same cut; one section is the usual case.
 *
 * Measured against one main video, named in `alignedTo`. Against any other —
 * a different file loaded, another job in a batch — it is not applied, and
 * the side chain is paired by time as an unaligned one is.
 */
export interface SideChainAlignment {
  alignedTo: string;
  speed: number;
  /** In main-video seconds; the first starts at 0. */
  sections: { from: number; offset: number }[];
  /** Moments that agreed / were clear enough to match / were tried. */
  matched: number;
  usable: number;
  samples: number;
}

/** Whether two paths name the same file, as the OS that wrote them compares them. */
export function samePath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  // Windows paths compare without case; a POSIX path never has a drive letter.
  const windows = /^[A-Za-z]:\//.test(norm(a));
  return windows ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

/** The fields of a step this file reads. Both Filter types satisfy it. */
export interface GraphStep {
  id: string;
  enabled: boolean;
  filterType: StepKind;
  order: number;
  preset?: string;
  code: string;
  modelPath?: string;
  /** A Load Video step's file. */
  sourcePath?: string;
  /** The Load Video step whose side chain this step is in; absent for the main chain. */
  chain?: string;
}

/** The id the main chain goes by. Never a step id. */
export const MAIN_CHAIN = '';

/**
 * Where side chains' preview outputs start. The main chain owns 0 (the
 * source) and one output per step after it, and everything that counts steps
 * — the preview's tab labels, a Load LUT's marker — counts those. Side chains
 * sit well clear of them, so adding one never renumbers a main-chain tab.
 */
export const SIDE_CHAIN_OUTPUT_BASE = 1000;

export function isSideChainHead(step: GraphStep): boolean {
  return step.filterType === 'videoSource';
}

/** A step of the main chain: not a Load Video, and not inside a side chain. */
export function isMainChainStep(step: GraphStep): boolean {
  return !isSideChainHead(step) && !step.chain;
}

/** Which chain a step is in. A Load Video step heads, and so names, its own. */
export function chainOf(step: GraphStep): string {
  return isSideChainHead(step) ? step.id : (step.chain ?? MAIN_CHAIN);
}

/**
 * Whether a step puts a picture into the chain at all.
 *
 * A model step with nothing chosen yet, a custom step with an empty body and a
 * Load Video with no file all sit in the list looking like steps and emit
 * nothing. None can be read from.
 */
export function producesPicture(step: GraphStep): boolean {
  if (step.filterType === 'videoSource') return Boolean(step.sourcePath);
  if (step.filterType === 'aiModel') return Boolean(step.modelPath);
  return step.code.trim().length > 0;
}

export interface Chain<S extends GraphStep = GraphStep> {
  id: string;
  /** The Load Video heading a side chain; null for the main chain. */
  head: S | null;
  /** The chain's steps below its head, top to bottom, disabled ones included. */
  steps: S[];
}

export interface ChainLayout<S extends GraphStep = GraphStep> {
  main: Chain<S>;
  /** Side chains top to bottom, by where their Load Video sits. */
  side: Chain<S>[];
  /**
   * Steps naming a side chain that no longer has its Load Video. They emit
   * nothing: running them on the main picture instead would be a quieter and
   * much worse failure than not running them at all.
   */
  orphans: S[];
}

const byOrder = <S extends GraphStep>(a: S, b: S) => a.order - b.order;

export function layoutChains<S extends GraphStep>(steps: S[]): ChainLayout<S> {
  const heads = steps.filter(isSideChainHead).sort(byOrder);
  const side = heads.map(head => ({ id: head.id, head, steps: [] as S[] }));
  const byId = new Map(side.map(chain => [chain.id, chain]));
  const main: Chain<S> = { id: MAIN_CHAIN, head: null, steps: [] };
  const orphans: S[] = [];

  for (const step of [...steps].sort(byOrder)) {
    if (isSideChainHead(step)) continue;
    const id = step.chain ?? MAIN_CHAIN;
    if (id === MAIN_CHAIN) main.steps.push(step);
    else if (byId.has(id)) byId.get(id)!.steps.push(step);
    else orphans.push(step);
  }
  return { main, side, orphans };
}

/**
 * The list in the order the rail shows it, with `order` renumbered to match:
 * each side chain (its Load Video, then its steps), then the main chain, then
 * orphans. The panel's add, remove, duplicate and drag code all work on array
 * positions; running this after each of them keeps a position meaning one
 * place in one chain, so none of that code has to know chains exist.
 */
export function normalizeChainOrder<S extends GraphStep>(steps: S[]): S[] {
  const { main, side, orphans } = layoutChains(steps);
  const ordered = [
    ...side.flatMap(chain => [chain.head!, ...chain.steps]),
    ...main.steps,
    ...orphans,
  ];
  return ordered.map((step, order) => (step.order === order ? step : { ...step, order }));
}

/** Whether a side chain will run: its Load Video is on and has a file. */
export function sideChainRuns(chain: Chain): boolean {
  return chain.head !== null && chain.head.enabled && producesPicture(chain.head);
}

/**
 * The step whose picture a side chain hands on: its last enabled step that
 * produces one, or the Load Video itself when nothing below it does.
 */
export function sideChainOutput<S extends GraphStep>(chain: Chain<S>): S | null {
  if (!chain.head) return null;
  const last = [...chain.steps].reverse().find(step => step.enabled && producesPicture(step));
  return last ?? chain.head;
}

/** What a side chain is called on a card or a preview tab. */
export function sideChainLabel(chain: Chain): string {
  const head = chain.head;
  if (!head) return 'Side chain';
  if (head.preset && head.preset !== 'Load Video') return head.preset;
  return head.sourcePath ? head.sourcePath.split(/[\\/]/).pop() || head.sourcePath : 'Side chain';
}

/**
 * The tag the rail prints beside a step: "3" in the main chain, "A" for the
 * first side chain's Load Video and "A2" for the second step below it.
 * Disabled steps are counted, because the tag is what the person is looking
 * at; '' for a step that is not in the list.
 */
export function stepTag(steps: GraphStep[], id: string): string {
  const { main, side } = layoutChains(steps);
  const inMain = main.steps.findIndex(step => step.id === id);
  if (inMain >= 0) return String(inMain + 1);
  for (let at = 0; at < side.length; at++) {
    const letter = sideChainLetter(at);
    if (side[at].id === id) return letter;
    const below = side[at].steps.findIndex(step => step.id === id);
    if (below >= 0) return `${letter}${below + 1}`;
  }
  return '';
}

/** A, B, … Z, then AA, AB: the side chain's place, as a letter. */
export function sideChainLetter(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** Everything a named input can be pointed at, and what is wrong with it. */
export type Reference<S extends GraphStep = GraphStep> =
  /** Nothing named: the reader's own chain's source, before any filter. */
  | { state: 'source' }
  /** A video file outside every chain; see referenceVideo.ts. */
  | { state: 'file'; video: ReferenceVideo }
  /** A whole side chain, read at its last step. */
  | { state: 'chain'; chain: Chain<S> }
  /** A side chain that is turned off or has no file. */
  | { state: 'chainOff'; chain: Chain<S> }
  /** The reader's own side chain, or one starting below it: either would loop. */
  | { state: 'chainLoop'; chain: Chain<S> }
  | { state: 'missing' }
  | { state: 'self' }
  /** A step in the middle of another chain. Only a chain's end is readable from outside it. */
  | { state: 'otherChain'; step: S }
  | { state: 'disabled'; step: S }
  | { state: 'below'; step: S }
  /** In the chain and above, but emitting nothing to read. */
  | { state: 'silent'; step: S }
  | { state: 'ready'; step: S };

/** Whether a reference resolves to a picture the generator can hand over. */
export function isReadable(reference: Reference): boolean {
  return reference.state === 'source' || reference.state === 'file'
    || reference.state === 'chain' || reference.state === 'ready';
}

/**
 * What `value` — a named input's stored value — points at, as read from
 * `reader`. The one place these rules live.
 */
export function resolveReference<S extends GraphStep>(steps: S[], reader: S, value: unknown): Reference<S> {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id) return { state: 'source' };
  const video = parseReferenceVideo(id);
  if (video) return { state: 'file', video };
  if (id === reader.id) return { state: 'self' };

  const step = steps.find(candidate => candidate.id === id);
  if (!step) return { state: 'missing' };

  if (isSideChainHead(step)) {
    const chain = layoutChains(steps).side.find(candidate => candidate.id === step.id)!;
    const readerChain = chainOf(reader);
    // A side chain may read one that starts above it, never its own or one
    // below: ordering by Load Video is what makes a loop impossible.
    if (readerChain !== MAIN_CHAIN) {
      const readerHead = steps.find(candidate => candidate.id === readerChain);
      if (readerChain === step.id || !readerHead || step.order >= readerHead.order) {
        return { state: 'chainLoop', chain };
      }
    }
    return sideChainRuns(chain) ? { state: 'chain', chain } : { state: 'chainOff', chain };
  }

  if (chainOf(step) !== chainOf(reader)) return { state: 'otherChain', step };
  if (!step.enabled) return { state: 'disabled', step };
  // Order, not enabled position: the two agree for enabled steps, and this is
  // the order the person is looking at.
  if (step.order >= reader.order) return { state: 'below', step };
  if (!producesPicture(step)) return { state: 'silent', step };
  return { state: 'ready', step };
}

/**
 * What a named input on `reader` could be pointed at: steps above it in its
 * own chain that produce a picture, and side chains it may read. Offering only
 * these is the cheapest guard there is — most broken states above are only
 * reachable by changing the chain after the choice was made.
 */
export function readableFrom<S extends GraphStep>(steps: S[], reader: S): { steps: S[]; chains: Chain<S>[] } {
  const own = chainOf(reader);
  const above = [...steps]
    .sort(byOrder)
    .filter(step => !isSideChainHead(step) && chainOf(step) === own
      && step.enabled && step.order < reader.order && producesPicture(step));
  const chains = layoutChains(steps).side
    .filter(chain => resolveReference(steps, reader, chain.id).state === 'chain');
  return { steps: above, chains };
}
