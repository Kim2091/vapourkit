// src/utils/lutInvert.ts — a known transform, run backwards.
//
// bakeChainToLut answers "where does this colour land?" for every cell of a
// lattice. This answers the other question — "what landed here?" — which is
// what a table has to know to put the source's colour back at the end of a
// chain.
//
// There is no algebraic inverse to reach for. The composed transform is an
// arbitrary stack of grades and imported tables, and the only thing every one
// of them has in common is that it is cheap to evaluate forwards. So each cell
// is a root find: start near the answer, then take damped Newton steps against
// a Jacobian measured by finite differences until F(x) lands on the cell.
//
// Two things about the result have to be said out loud rather than buried.
//
//   Clipping is not reversible. A grade that drove the highlights to white
//   sent a whole range of inputs to the same colour, and no table can say
//   which of them a pixel came from. Those cells still solve — they just solve
//   ambiguously — so the honest measure is not "cells that failed" but how
//   much of the range went in and came out pinned. That is measured directly
//   and reported as clippedInput.
//
//   Some colours are simply never produced. A grade that pulls saturation down
//   cannot make a vivid red, so the vivid corner of the cube has no preimage
//   at all. Those cells cannot be solved and do not need to be: nothing in the
//   picture can be that colour either. They are filled from their neighbours
//   so the table stays continuous, and counted, but they are not a loss.

import { identityLut, lutIndex, type ColorOperation, type Lut } from './lut';

export interface InvertedLut {
  lut: Lut;
  /**
   * How much of the input range the forward transform pinned against black or
   * white, as a fraction of the volume sampled.
   *
   * This is the number worth putting in front of someone. It is the part of
   * the picture the grade threw away, and no inverse can bring it back —
   * everything that landed on white comes back as the same colour, whatever it
   * was before.
   */
  clippedInput: number;
  /**
   * Cells the solve could not reach, filled from their neighbours.
   *
   * Ordinary, and often large: a desaturating grade leaves a third of the cube
   * with no preimage. Nothing in the picture can be those colours, so they are
   * only ever touched by interpolation near the edge of the gamut. Worth a
   * line in the log, not a warning.
   */
  unreachable: number;
  unreachableFraction: number;
  /** The worst residual among the cells that did land, in 0..1. */
  maxResidual: number;
}

/**
 * Close enough to call a cell solved: half a code value at 8 bits.
 *
 * Tighter than this is chasing noise — the table is going to be interpolated
 * between cells anyway, and lut.test.ts already measures that error at nearly
 * 3 code values for a 33-cube. Looser starts hiding real failures to converge.
 */
const TOLERANCE = 0.5 / 255;

/** Newton steps per cell. Grades are smooth; five is generous. */
const MAX_STEPS = 5;

/**
 * How many times a cell may be attempted before it is left alone.
 *
 * A cell reached from one neighbour may fail and then land when a different
 * neighbour is solved and offers a better place to start — approaching a knee
 * from the other side is often all it takes. Three is enough for that to
 * happen without letting a genuinely unreachable region cycle.
 */
const MAX_ATTEMPTS = 3;

/** Step for the finite-difference Jacobian, in 0..1 colour. */
const DELTA = 1 / 512;

/**
 * Lattice the seed pass walks. Fixed rather than tied to the output size: its
 * job is to plant one answer in each region the flood then spreads out from,
 * and 33³ does that for a 65-cube as well as for a 17-cube.
 */
const SEED_SIZE = 33;

/** Close enough to the end of the range to count as pinned there. */
const LIMIT = 1e-6;

/** A Jacobian row this small means the output is not moving at all. */
const FLAT = 1e-6;

type Triple = [number, number, number];

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * Solve a symmetric positive-definite 3x3 by LDLᵀ.
 *
 * Cramer's rule with a determinant floor was wrong for this, and wrong in a
 * way that looked like a modelling problem rather than an arithmetic one: the
 * damped matrix below is deliberately near-singular whenever a channel has
 * clipped, so its determinant is legitimately in the 1e-15 range while the
 * system itself is perfectly solvable. Rejecting on the size of a determinant
 * threw away those cells — which are exactly the cells at the ends of the
 * range, where a grade does its most visible work.
 *
 * LDLᵀ has no such threshold. Every pivot of an SPD matrix is positive, so a
 * pivot that is not is the only failure worth reporting, and that test does
 * not care how large the matrix is.
 */
function solveSpd3(m: number[], rhs: Triple): Triple | null {
  const a00 = m[0], a01 = m[1], a02 = m[2];
  const a11 = m[4], a12 = m[5], a22 = m[8];

  const d0 = a00;
  if (!(d0 > 0) || !Number.isFinite(d0)) return null;
  const l10 = a01 / d0;
  const l20 = a02 / d0;

  const d1 = a11 - l10 * a01;
  if (!(d1 > 0) || !Number.isFinite(d1)) return null;
  const l21 = (a12 - l20 * a01) / d1;

  const d2 = a22 - l20 * a02 - l21 * l21 * d1;
  if (!(d2 > 0) || !Number.isFinite(d2)) return null;

  // Forward substitution through L, scale by D, back substitution through Lᵀ.
  const y0 = rhs[0];
  const y1 = rhs[1] - l10 * y0;
  const y2 = rhs[2] - l20 * y0 - l21 * y1;

  const z2 = y2 / d2;
  const z1 = y1 / d1 - l21 * z2;
  const z0 = y0 / d0 - l10 * z1 - l20 * z2;

  return Number.isFinite(z0) && Number.isFinite(z1) && Number.isFinite(z2)
    ? [z0, z1, z2]
    : null;
}

/**
 * How the output moves when each input channel does, measured about `x`.
 *
 * Row-major: row i is output channel i, column j is input channel j. Forward
 * differences, because a central pair would double the evaluations to buy
 * accuracy the solve does not need — except at the top of the range, where
 * there is no room to step forwards and it leans back instead. Reading that
 * edge as "this colour cannot be reached" would condemn every cell whose
 * answer sits at white, which under any grade that clips highlights is a great
 * many of them.
 */
function jacobianAt(
  forward: (rgb: Triple) => Triple,
  x: Triple,
  out: Triple,
): number[] | null {
  const columns: number[] = [];
  for (let j = 0; j < 3; j++) {
    const probe: Triple = [...x] as Triple;
    probe[j] = x[j] + DELTA <= 1 ? x[j] + DELTA : x[j] - DELTA;
    const shift = probe[j] - x[j];
    if (shift === 0) return null;
    const moved = forward(probe);
    columns.push(
      (moved[0] - out[0]) / shift,
      (moved[1] - out[1]) / shift,
      (moved[2] - out[2]) / shift,
    );
  }
  return [
    columns[0], columns[3], columns[6],
    columns[1], columns[4], columns[7],
    columns[2], columns[5], columns[8],
  ];
}

/**
 * The step to take, as a damped least squares solve rather than a plain
 * Newton one: (JᵀJ + λI) dx = Jᵀ r.
 *
 * The damping is what makes a partly-stuck cell survive. Once a single channel
 * clips, its row of the Jacobian is zeroes and the matrix is singular — but
 * only in that one direction, and the other two channels are still perfectly
 * solvable. An undamped solve refuses the whole cell; with λ in place the flat
 * direction gets a step of nearly nothing while the live ones move, which is
 * the behaviour that was wanted all along.
 *
 * λ is scaled to the matrix so it stays negligible for a healthy Jacobian,
 * where this reduces to the Newton step, and only asserts itself where the
 * alternative was giving up.
 */
function dampedStep(jacobian: number[], residual: Triple): Triple | null {
  const [a, b, c, d, e, f, g, h, i] = jacobian;
  // JᵀJ, symmetric, written out rather than looped: it is nine terms.
  const n00 = a * a + d * d + g * g;
  const n01 = a * b + d * e + g * h;
  const n02 = a * c + d * f + g * i;
  const n11 = b * b + e * e + h * h;
  const n12 = b * c + e * f + h * i;
  const n22 = c * c + f * f + i * i;

  const scale = (n00 + n11 + n22) / 3;
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const lambda = scale * 1e-6;

  const gradient: Triple = [
    a * residual[0] + d * residual[1] + g * residual[2],
    b * residual[0] + e * residual[1] + h * residual[2],
    c * residual[0] + f * residual[1] + i * residual[2],
  ];

  return solveSpd3([
    n00 + lambda, n01, n02,
    n01, n11 + lambda, n12,
    n02, n12, n22 + lambda,
  ], gradient);
}

/**
 * Invert a composed stack of colour operations onto a lattice.
 *
 * The operations are given in the order they run forwards — the same order
 * bakeChainToLut takes them in — and the table that comes back undoes all of
 * them at once. Composing forwards and inverting the whole thing is not the
 * same as inverting each step and reversing the list: the second only works
 * when every step is separately invertible, and the first is what is actually
 * being asked.
 */
export function invertOperations(
  operations: readonly { apply: ColorOperation }[],
  size: number,
  title?: string,
): InvertedLut {
  if (!Number.isInteger(size) || size < 2 || size > 256) {
    throw new Error(`${size} is not a usable cube size`);
  }

  // Nothing in the way is not a failure to invert; it is an identity, and the
  // caller has a right to be told so by getting a table that does nothing.
  if (operations.length === 0) {
    return {
      lut: { ...identityLut(size), title },
      clippedInput: 0,
      unreachable: 0,
      unreachableFraction: 0,
      maxResidual: 0,
    };
  }

  const forward = (rgb: Triple): Triple => {
    let pixel: Triple = rgb;
    for (const operation of operations) pixel = operation.apply(pixel);
    return pixel;
  };

  const cells = size * size * size;
  const step = 1 / (size - 1);
  const data = new Float32Array(cells * 3);
  const landed = new Uint8Array(cells);

  // Seed pass. Two jobs at once: plant a known-good input in each output cell
  // the transform actually reaches, and measure how much of the input range
  // came out pinned against an end of the scale.
  const seed = new Float32Array(cells * 3);
  const seeded = new Uint8Array(cells);
  const seedDistance = new Float32Array(cells).fill(Infinity);
  const seedStep = 1 / (SEED_SIZE - 1);
  const seedCount = SEED_SIZE * SEED_SIZE * SEED_SIZE;
  let clippedSeeds = 0;

  for (let b = 0; b < SEED_SIZE; b++) {
    for (let g = 0; g < SEED_SIZE; g++) {
      for (let r = 0; r < SEED_SIZE; r++) {
        const input: Triple = [r * seedStep, g * seedStep, b * seedStep];
        const out = forward(input);

        const or = Math.round(clamp01(out[0]) * (size - 1));
        const og = Math.round(clamp01(out[1]) * (size - 1));
        const ob = Math.round(clamp01(out[2]) * (size - 1));
        const dr = out[0] - or * step;
        const dg = out[1] - og * step;
        const db = out[2] - ob * step;
        const distance = dr * dr + dg * dg + db * db;
        const cell = (ob * size + og) * size + or;
        if (distance < seedDistance[cell]) {
          seedDistance[cell] = distance;
          seed[cell * 3] = input[0];
          seed[cell * 3 + 1] = input[1];
          seed[cell * 3 + 2] = input[2];
          seeded[cell] = 1;
        }

        // Sitting at an end of the range is not clipping on its own — white
        // input under a neutral grade is meant to come out white. What makes
        // it clipping is that the output has stopped responding: the input can
        // move and this channel cannot follow, so everything around it arrives
        // at the same colour and the difference between them is gone.
        const pinned = (out[0] <= LIMIT || out[0] >= 1 - LIMIT)
          || (out[1] <= LIMIT || out[1] >= 1 - LIMIT)
          || (out[2] <= LIMIT || out[2] >= 1 - LIMIT);
        if (!pinned) continue;
        const rows = jacobianAt(forward, input, out);
        if (!rows) { clippedSeeds++; continue; }
        for (let channel = 0; channel < 3; channel++) {
          const atLimit = out[channel] <= LIMIT || out[channel] >= 1 - LIMIT;
          if (!atLimit) continue;
          const flat = Math.abs(rows[channel * 3]) < FLAT
            && Math.abs(rows[channel * 3 + 1]) < FLAT
            && Math.abs(rows[channel * 3 + 2]) < FLAT;
          if (flat) { clippedSeeds++; break; }
        }
      }
    }
  }

  let maxResidual = 0;

  /** Where a cell sits in colour, from its index. */
  const targetOf = (cell: number): Triple => [
    (cell % size) * step,
    (Math.floor(cell / size) % size) * step,
    Math.floor(cell / (size * size)) * step,
  ];

  /** Take damped Newton steps from `from` until F(x) lands on `target`. */
  const solveCell = (target: Triple, from: Triple) => {
    let x: Triple = [clamp01(from[0]), clamp01(from[1]), clamp01(from[2])];
    let out = forward(x);
    let residual = Math.max(
      Math.abs(out[0] - target[0]),
      Math.abs(out[1] - target[1]),
      Math.abs(out[2] - target[2]),
    );

    for (let iteration = 0; iteration < MAX_STEPS && residual > TOLERANCE; iteration++) {
      const rows = jacobianAt(forward, x, out);
      if (!rows) break;

      const delta = dampedStep(rows, [
        target[0] - out[0],
        target[1] - out[1],
        target[2] - out[2],
      ]);
      if (!delta) break;

      // Backtrack rather than trust the full step. A grade with a knee in it
      // can throw an undamped step across the range and never come back, and
      // halving costs one evaluation to find out.
      let accepted = false;
      for (let scale = 1; scale >= 0.125; scale /= 2) {
        const candidate: Triple = [
          clamp01(x[0] + delta[0] * scale),
          clamp01(x[1] + delta[1] * scale),
          clamp01(x[2] + delta[2] * scale),
        ];
        const candidateOut = forward(candidate);
        const candidateResidual = Math.max(
          Math.abs(candidateOut[0] - target[0]),
          Math.abs(candidateOut[1] - target[1]),
          Math.abs(candidateOut[2] - target[2]),
        );
        if (candidateResidual < residual) {
          x = candidate;
          out = candidateOut;
          residual = candidateResidual;
          accepted = true;
          break;
        }
      }
      if (!accepted) break;
    }

    return { x, residual };
  };

  // Cells are solved in the order the answers spread, not in the order they
  // are stored.
  //
  // Newton is a local method, and the one place it cannot help itself is a
  // clipped plateau: sitting in the flat region, every derivative is zero, so
  // nothing points back towards the part of the range that still moves. A
  // raster scan walks straight into that — each cell warms the next one up, so
  // one stranded cell strands the whole row behind it.
  //
  // Flooding outwards from the seeded cells instead means every cell starts
  // from a neighbour's *solved* answer, which by construction is a real
  // preimage rather than a point on the plateau. The inverse is continuous
  // wherever it exists at all, so a neighbour's answer is always a good start,
  // and the seeds only have to reach one cell of each region rather than most
  // of them — which matters, because a transform that compresses the range
  // hard has far fewer distinct outputs than the lattice has cells.
  const startAt = new Float32Array(cells * 3);
  const queued = new Uint8Array(cells);
  const attempts = new Uint8Array(cells);
  const queue: number[] = [];

  for (let cell = 0; cell < cells; cell++) {
    const target = targetOf(cell);
    startAt[cell * 3] = target[0];
    startAt[cell * 3 + 1] = target[1];
    startAt[cell * 3 + 2] = target[2];
    if (!seeded[cell]) continue;
    startAt[cell * 3] = seed[cell * 3];
    startAt[cell * 3 + 1] = seed[cell * 3 + 1];
    startAt[cell * 3 + 2] = seed[cell * 3 + 2];
    queue.push(cell);
    queued[cell] = 1;
  }

  const plane = size * size;
  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head];
    queued[cell] = 0;
    if (landed[cell]) continue;
    attempts[cell]++;

    const solved = solveCell(targetOf(cell), [
      startAt[cell * 3], startAt[cell * 3 + 1], startAt[cell * 3 + 2],
    ]);

    // Kept whether it landed or not, so a later neighbour can offer this cell
    // a better place to start than the one that just failed.
    startAt[cell * 3] = solved.x[0];
    startAt[cell * 3 + 1] = solved.x[1];
    startAt[cell * 3 + 2] = solved.x[2];
    if (solved.residual > TOLERANCE) continue;

    const r = cell % size;
    const g = Math.floor(cell / size) % size;
    const b = Math.floor(cell / plane);
    const at = lutIndex(size, r, g, b);
    data[at] = solved.x[0];
    data[at + 1] = solved.x[1];
    data[at + 2] = solved.x[2];
    landed[cell] = 1;
    if (solved.residual > maxResidual) maxResidual = solved.residual;

    // Hand the answer to the six neighbours as their starting point. A cell
    // gets a few goes at most — approached from another direction it may well
    // land, but retrying forever would turn a stubborn region into a spin.
    const neighbours = [
      r > 0 ? cell - 1 : -1,
      r < size - 1 ? cell + 1 : -1,
      g > 0 ? cell - size : -1,
      g < size - 1 ? cell + size : -1,
      b > 0 ? cell - plane : -1,
      b < size - 1 ? cell + plane : -1,
    ];
    for (const next of neighbours) {
      if (next < 0 || landed[next]) continue;
      if (attempts[next] >= MAX_ATTEMPTS) continue;
      // Refreshed even for a cell already waiting its turn. What it is holding
      // may have come from a neighbour sitting on a plateau, where every
      // derivative is zero and the solve has nowhere to go; this answer is a
      // real preimage. Skipping the update because the cell was already queued
      // is what used to leave a shell of cells stuck at the bottom of the
      // range, each one attempted exactly once, from the one place it could
      // not move away from.
      startAt[next * 3] = solved.x[0];
      startAt[next * 3 + 1] = solved.x[1];
      startAt[next * 3 + 2] = solved.x[2];
      if (queued[next]) continue;
      queue.push(next);
      queued[next] = 1;
    }
  }

  // A sweep to finish, so the result does not depend on the order the flood
  // happened to reach things. Anything still empty is retried from whichever
  // neighbour has since been solved, until a pass changes nothing — which for
  // a transform with a genuine gap in its gamut is the first pass.
  for (let pass = 0; pass < 4; pass++) {
    let progressed = false;
    for (let cell = 0; cell < cells; cell++) {
      if (landed[cell]) continue;
      const r = cell % size;
      const g = Math.floor(cell / size) % size;
      const b = Math.floor(cell / plane);
      const neighbours = [
        r > 0 ? cell - 1 : -1,
        r < size - 1 ? cell + 1 : -1,
        g > 0 ? cell - size : -1,
        g < size - 1 ? cell + size : -1,
        b > 0 ? cell - plane : -1,
        b < size - 1 ? cell + plane : -1,
      ];
      for (const from of neighbours) {
        if (from < 0 || !landed[from]) continue;
        const at = lutIndex(size, from % size, Math.floor(from / size) % size, Math.floor(from / plane));
        const solved = solveCell(targetOf(cell), [data[at], data[at + 1], data[at + 2]]);
        if (solved.residual > TOLERANCE) continue;
        const here = lutIndex(size, r, g, b);
        data[here] = solved.x[0];
        data[here + 1] = solved.x[1];
        data[here + 2] = solved.x[2];
        landed[cell] = 1;
        if (solved.residual > maxResidual) maxResidual = solved.residual;
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }

  let unreachable = 0;
  for (let cell = 0; cell < cells; cell++) if (!landed[cell]) unreachable++;

  fillUnreachable(data, landed, size);

  return {
    lut: { kind: '3d', size, data, domainMin: [0, 0, 0], domainMax: [1, 1, 1], title },
    clippedInput: clippedSeeds / seedCount,
    unreachable,
    unreachableFraction: unreachable / cells,
    maxResidual,
  };
}

/**
 * Grow the solved cells outwards into the ones that were not.
 *
 * A hole in a table is worse than a guess in it: the picture would tear at the
 * edge of the region rather than merely drift inside it. So each pass averages
 * every empty cell over whichever of its six neighbours are filled, one shell
 * at a time, until the table is continuous.
 */
function fillUnreachable(data: Float32Array, landed: Uint8Array, size: number): void {
  const cells = size * size * size;
  let remaining = 0;
  for (let i = 0; i < cells; i++) if (!landed[i]) remaining++;
  if (remaining === 0) return;

  const step = 1 / (size - 1);
  if (remaining === cells) {
    // Nothing converged anywhere. An identity is the only fill left that is
    // not a lie, and the unreachable count says how much of one it is.
    for (let b = 0; b < size; b++) {
      for (let g = 0; g < size; g++) {
        for (let r = 0; r < size; r++) {
          const at = lutIndex(size, r, g, b);
          data[at] = r * step;
          data[at + 1] = g * step;
          data[at + 2] = b * step;
        }
      }
    }
    return;
  }

  const filled = Uint8Array.from(landed);
  // Bounded by the longest run of empty cells a lattice can hold, so a table
  // that somehow never closes cannot spin here.
  for (let pass = 0; pass < size * 3 && remaining > 0; pass++) {
    const wrote: number[] = [];
    for (let b = 0; b < size; b++) {
      for (let g = 0; g < size; g++) {
        for (let r = 0; r < size; r++) {
          const cell = (b * size + g) * size + r;
          if (filled[cell]) continue;

          let count = 0;
          let sumR = 0, sumG = 0, sumB = 0;
          const neighbours: [number, number, number][] = [
            [r - 1, g, b], [r + 1, g, b],
            [r, g - 1, b], [r, g + 1, b],
            [r, g, b - 1], [r, g, b + 1],
          ];
          for (const [nr, ng, nb] of neighbours) {
            if (nr < 0 || ng < 0 || nb < 0 || nr >= size || ng >= size || nb >= size) continue;
            if (!filled[(nb * size + ng) * size + nr]) continue;
            const at = lutIndex(size, nr, ng, nb);
            sumR += data[at];
            sumG += data[at + 1];
            sumB += data[at + 2];
            count++;
          }
          if (count === 0) continue;

          const at = lutIndex(size, r, g, b);
          data[at] = sumR / count;
          data[at + 1] = sumG / count;
          data[at + 2] = sumB / count;
          wrote.push(cell);
        }
      }
    }
    // Marked after the pass, not during it, so a shell grows evenly rather
    // than smearing along whichever axis the loop happens to run fastest.
    for (const cell of wrote) filled[cell] = 1;
    remaining -= wrote.length;
    if (wrote.length === 0) break;
  }
}
