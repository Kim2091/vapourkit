// src/utils/lut.ts — reading and writing colour lookup tables.
//
// One canonical Lut type, and a parser and serialiser per format. Everything
// else in Vapourkit — the exporter that bakes a grade, the filter step that
// applies an imported table — works on that type and never on file text.
//
// The two conventions that silently corrupt a LUT if you get them wrong are
// both about ordering, and they disagree between the formats:
//
//   .cube  (Adobe/Iridas)      red changes fastest, blue slowest
//   .3dl   (Autodesk Lustre)   blue changes fastest, red slowest
//
// This is the ordering OpenColorIO uses for each, and it is what the tests
// pin with an asymmetric table — one that reads back wrong, rather than
// merely differently, if the loops are transposed.

import { gradePixel, type GradeValues } from './colorGrade';

/** A parsed table, always in 0..1 floats regardless of what the file held. */
export interface Lut {
  kind: '1d' | '3d';
  /** Entries per axis. A 3D table holds size^3 triples, a 1D one holds size. */
  size: number;
  /** Interleaved RGB triples, red-fastest for 3D — the .cube convention. */
  data: Float32Array;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  title?: string;
}

export type LutFormat = 'cube' | '3dl';

/** Sizes worth offering. 33 is what most applications ship. */
export const LUT_SIZES = [17, 33, 65] as const;
export const DEFAULT_LUT_SIZE = 33;

const MAX_3D_SIZE = 256;
const MAX_1D_SIZE = 65536;

export class LutParseError extends Error {
  constructor(message: string, readonly line?: number) {
    super(line === undefined ? message : `line ${line}: ${message}`);
    this.name = 'LutParseError';
  }
}

/** Index of the triple at (r, g, b) in a red-fastest 3D table. */
export function lutIndex(size: number, r: number, g: number, b: number): number {
  return ((b * size + g) * size + r) * 3;
}

export function identityLut(size: number, kind: '1d' | '3d' = '3d'): Lut {
  const count = kind === '3d' ? size * size * size : size;
  const data = new Float32Array(count * 3);
  const step = size > 1 ? 1 / (size - 1) : 0;
  if (kind === '1d') {
    for (let i = 0; i < size; i++) {
      data[i * 3] = data[i * 3 + 1] = data[i * 3 + 2] = i * step;
    }
  } else {
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
  }
  return { kind, size, data, domainMin: [0, 0, 0], domainMax: [1, 1, 1] };
}

/**
 * Sample a 3D table with trilinear interpolation. This is the reference the
 * shader and the emitted VapourSynth expression are checked against, the same
 * way gradePixel is for the grade itself.
 */
export function sampleLut(lut: Lut, rgb: readonly [number, number, number]): [number, number, number] {
  const { size, data, domainMin, domainMax } = lut;
  const out: [number, number, number] = [0, 0, 0];

  if (lut.kind === '1d') {
    for (let c = 0; c < 3; c++) {
      const span = domainMax[c] - domainMin[c] || 1;
      const t = Math.min(1, Math.max(0, (rgb[c] - domainMin[c]) / span)) * (size - 1);
      const low = Math.floor(t);
      const high = Math.min(size - 1, low + 1);
      const f = t - low;
      out[c] = data[low * 3 + c] * (1 - f) + data[high * 3 + c] * f;
    }
    return out;
  }

  const axis = (value: number, c: number) => {
    const span = domainMax[c] - domainMin[c] || 1;
    return Math.min(1, Math.max(0, (value - domainMin[c]) / span)) * (size - 1);
  };
  const x = axis(rgb[0], 0), y = axis(rgb[1], 1), z = axis(rgb[2], 2);
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const x1 = Math.min(size - 1, x0 + 1), y1 = Math.min(size - 1, y0 + 1), z1 = Math.min(size - 1, z0 + 1);
  const fx = x - x0, fy = y - y0, fz = z - z0;

  for (let c = 0; c < 3; c++) {
    const c00 = data[lutIndex(size, x0, y0, z0) + c] * (1 - fx) + data[lutIndex(size, x1, y0, z0) + c] * fx;
    const c10 = data[lutIndex(size, x0, y1, z0) + c] * (1 - fx) + data[lutIndex(size, x1, y1, z0) + c] * fx;
    const c01 = data[lutIndex(size, x0, y0, z1) + c] * (1 - fx) + data[lutIndex(size, x1, y0, z1) + c] * fx;
    const c11 = data[lutIndex(size, x0, y1, z1) + c] * (1 - fx) + data[lutIndex(size, x1, y1, z1) + c] * fx;
    const c0 = c00 * (1 - fy) + c10 * fy;
    const c1 = c01 * (1 - fy) + c11 * fy;
    out[c] = c0 * (1 - fz) + c1 * fz;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* .cube — Adobe/Iridas                                                */
/* ------------------------------------------------------------------ */

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

function numbers(fields: string[], line: number): number[] {
  return fields.map(field => {
    if (!NUMBER.test(field)) throw new LutParseError(`"${field}" is not a number`, line);
    return Number(field);
  });
}

export function parseCube(text: string): Lut {
  const lines = text.split(/\r?\n/);
  let kind: '1d' | '3d' | null = null;
  let size = 0;
  let title: string | undefined;
  const domainMin: [number, number, number] = [0, 0, 0];
  const domainMax: [number, number, number] = [1, 1, 1];
  const rows: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].split('#')[0].trim();
    if (!line) continue;
    const fields = line.split(/\s+/);
    const keyword = fields[0].toUpperCase();

    if (keyword === 'TITLE') {
      title = line.slice(fields[0].length).trim().replace(/^"|"$/g, '');
    } else if (keyword === 'LUT_3D_SIZE' || keyword === 'LUT_1D_SIZE') {
      if (kind) throw new LutParseError('the file declares its size twice', i + 1);
      kind = keyword === 'LUT_3D_SIZE' ? '3d' : '1d';
      size = numbers([fields[1] ?? ''], i + 1)[0];
      const limit = kind === '3d' ? MAX_3D_SIZE : MAX_1D_SIZE;
      if (!Number.isInteger(size) || size < 2 || size > limit) {
        throw new LutParseError(`size ${size} is outside the 2..${limit} a ${kind} cube allows`, i + 1);
      }
    } else if (keyword === 'DOMAIN_MIN' || keyword === 'DOMAIN_MAX') {
      const values = numbers(fields.slice(1, 4), i + 1);
      if (values.length !== 3) throw new LutParseError(`${keyword} needs three values`, i + 1);
      const target = keyword === 'DOMAIN_MIN' ? domainMin : domainMax;
      target[0] = values[0]; target[1] = values[1]; target[2] = values[2];
    } else if (keyword === 'LUT_3D_INPUT_RANGE' || keyword === 'LUT_1D_INPUT_RANGE') {
      const values = numbers(fields.slice(1, 3), i + 1);
      domainMin[0] = domainMin[1] = domainMin[2] = values[0];
      domainMax[0] = domainMax[1] = domainMax[2] = values[1];
    } else if (NUMBER.test(fields[0])) {
      const values = numbers(fields.slice(0, 3), i + 1);
      if (values.length !== 3) throw new LutParseError('a table row needs three values', i + 1);
      rows.push(values[0], values[1], values[2]);
    } else {
      throw new LutParseError(`unrecognised keyword "${fields[0]}"`, i + 1);
    }
  }

  if (!kind) throw new LutParseError('no LUT_3D_SIZE or LUT_1D_SIZE — this is not a .cube file');
  const expected = (kind === '3d' ? size * size * size : size) * 3;
  if (rows.length !== expected) {
    throw new LutParseError(
      `LUT_${kind === '3d' ? '3D' : '1D'}_SIZE ${size} needs ${expected / 3} rows, found ${rows.length / 3}`,
    );
  }
  for (let c = 0; c < 3; c++) {
    if (!(domainMax[c] > domainMin[c])) throw new LutParseError('DOMAIN_MAX must exceed DOMAIN_MIN');
  }

  return { kind, size, data: Float32Array.from(rows), domainMin, domainMax, title };
}

const fixed = (value: number) => {
  const text = value.toFixed(6);
  // -0.000000 is valid but reads as a mistake in a file people open in an editor.
  return text === '-0.000000' ? '0.000000' : text;
};

export function writeCube(lut: Lut, title?: string): string {
  const name = title ?? lut.title;
  const out: string[] = ['# Created by Vapourkit'];
  if (name) out.push(`TITLE "${name.replace(/"/g, "'")}"`);
  out.push('');
  out.push(`LUT_${lut.kind === '3d' ? '3D' : '1D'}_SIZE ${lut.size}`);
  if (lut.domainMin.some(v => v !== 0) || lut.domainMax.some(v => v !== 1)) {
    out.push(`DOMAIN_MIN ${lut.domainMin.map(fixed).join(' ')}`);
    out.push(`DOMAIN_MAX ${lut.domainMax.map(fixed).join(' ')}`);
  }
  out.push('');
  const entries = lut.data.length / 3;
  for (let i = 0; i < entries; i++) {
    out.push(`${fixed(lut.data[i * 3])} ${fixed(lut.data[i * 3 + 1])} ${fixed(lut.data[i * 3 + 2])}`);
  }
  out.push('');
  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* .3dl — Autodesk Lustre / Flame                                      */
/* ------------------------------------------------------------------ */

/**
 * .3dl carries integers, not floats, and the scale is usually implied rather
 * than declared. Inferring it from the largest value in the table — which is
 * what OpenColorIO does, and what this used to do alone — is wrong for any
 * LUT that never gets bright: a table whose peak output is 0.25 has a largest
 * integer of 1023 at 12-bit, reads back as 10-bit, and comes out four times
 * too light. Measured, a plain darken round-tripped 168/255 off.
 *
 * So the depth is taken from the first of these that exists:
 *
 *   1. a Lustre "Mesh <in> <out>" header, which states it outright
 *   2. the top of the input ramp, which write3dl writes at the output scale
 *   3. the largest value in the table, the old guess, for files with neither
 *
 * write3dl emits both 1 and 2, because other tools infer the same way and a
 * dark export would otherwise be mis-scaled by them too.
 */
function depthForMax(maxValue: number): number {
  for (const bits of [8, 10, 12, 14, 16]) {
    if (maxValue <= (1 << bits) - 1) return bits;
  }
  return 16;
}

export function parse3dl(text: string): Lut {
  const lines = text.split(/\r?\n/);
  let ramp: number[] | null = null;
  let declaredDepth: number | null = null;
  const rows: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].split('#')[0].trim();
    if (!line) continue;
    const fields = line.split(/\s+/);
    // Lustre writes a "3DMESH" block header, and "Mesh <in> <out>" before the
    // ramp. The second states the output depth, which is the one thing that
    // cannot be recovered reliably from the numbers alone.
    if (!NUMBER.test(fields[0])) {
      if (fields[0].toUpperCase() === 'MESH' && fields.length >= 3) {
        const bits = Number(fields[2]);
        if (Number.isInteger(bits) && bits >= 1 && bits <= 32) declaredDepth = bits;
      }
      continue;
    }

    const values = numbers(fields, i + 1);
    // The ramp is the first numeric line, and it has to be recognised by
    // position rather than by length: a size-3 ramp is "0 2048 4095", which
    // is three integers and indistinguishable from a table row. Requiring it
    // to ascend is what catches a file that has no ramp at all, where this
    // would otherwise silently eat the first entry of the table.
    if (ramp === null) {
      for (let at = 1; at < values.length; at++) {
        if (values[at] <= values[at - 1]) {
          throw new LutParseError('the first line must be an ascending input ramp', i + 1);
        }
      }
      ramp = values;
      continue;
    }
    if (values.length !== 3) throw new LutParseError('a table row needs three values', i + 1);
    rows.push(values[0], values[1], values[2]);
  }

  if (!ramp) throw new LutParseError('no input ramp — this is not a .3dl file');
  const size = ramp.length;
  if (size < 2 || size > MAX_3D_SIZE) {
    throw new LutParseError(`an input ramp of ${size} entries is not a usable cube size`);
  }
  const expected = size * size * size * 3;
  if (rows.length !== expected) {
    throw new LutParseError(`a ramp of ${size} needs ${expected / 3} rows, found ${rows.length / 3}`);
  }

  let peak = 0;
  for (const value of rows) {
    if (value < 0) throw new LutParseError('.3dl values are unsigned integers');
    if (value > peak) peak = value;
  }
  const rampTop = ramp[ramp.length - 1];
  const scale = declaredDepth !== null
    ? (1 << declaredDepth) - 1
    : (1 << depthForMax(Math.max(peak, rampTop))) - 1;

  // Transposed on the way in: .3dl runs blue fastest, and everything past this
  // function is red-fastest.
  const data = new Float32Array(expected);
  let at = 0;
  for (let r = 0; r < size; r++) {
    for (let g = 0; g < size; g++) {
      for (let b = 0; b < size; b++) {
        const target = lutIndex(size, r, g, b);
        data[target] = rows[at] / scale;
        data[target + 1] = rows[at + 1] / scale;
        data[target + 2] = rows[at + 2] / scale;
        at += 3;
      }
    }
  }
  return { kind: '3d', size, data, domainMin: [0, 0, 0], domainMax: [1, 1, 1] };
}

export function write3dl(lut: Lut, bitDepth: 10 | 12 | 16 = 12): string {
  if (lut.kind !== '3d') throw new Error('.3dl holds 3D tables only; write a .cube for a 1D one');
  const { size, data } = lut;
  const scale = (1 << bitDepth) - 1;
  const out: string[] = ['# Created by Vapourkit'];
  // Stated outright, because inferring the depth from the table is what
  // breaks on a dark LUT — here and in every other tool that reads one.
  out.push('3DMESH');
  out.push(`Mesh ${bitDepth} ${bitDepth}`);
  // The input ramp, at the same depth as the output, so a reader that ignores
  // the header still has something better than the table's peak to go on.
  out.push(Array.from({ length: size }, (_, i) => Math.round((i / (size - 1)) * scale)).join(' '));

  for (let r = 0; r < size; r++) {
    for (let g = 0; g < size; g++) {
      for (let b = 0; b < size; b++) {
        const at = lutIndex(size, r, g, b);
        const quantise = (value: number) =>
          Math.max(0, Math.min(scale, Math.round(value * scale)));
        out.push(`${quantise(data[at])} ${quantise(data[at + 1])} ${quantise(data[at + 2])}`);
      }
    }
  }
  out.push('');
  return out.join('\n');
}

/** Pick a parser from the file name, so callers never sniff extensions. */
export function parseLut(text: string, fileName: string): Lut {
  const extension = fileName.toLowerCase().split('.').pop();
  if (extension === 'cube') return parseCube(text);
  if (extension === '3dl') return parse3dl(text);
  throw new LutParseError(`Vapourkit reads .cube and .3dl; "${fileName}" is neither`);
}

export function writeLut(lut: Lut, format: LutFormat, title?: string): string {
  return format === 'cube' ? writeCube(lut, title) : write3dl(lut);
}

/* ------------------------------------------------------------------ */
/* Baking a grade                                                      */
/* ------------------------------------------------------------------ */

/**
 * Evaluate the grade over a lattice. gradePixel is the definition the shader
 * and the emitted Expr are both held to, so a table baked from it is the same
 * grade to within the interpolation error of the size chosen — which the
 * tests measure rather than assume.
 */
export function bakeGradeToLut(values: GradeValues, size: number, title?: string): Lut {
  if (!Number.isInteger(size) || size < 2 || size > MAX_3D_SIZE) {
    throw new Error(`${size} is not a usable cube size`);
  }
  const data = new Float32Array(size * size * size * 3);
  const step = 1 / (size - 1);
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const graded = gradePixel([r * step, g * step, b * step], values);
        const at = lutIndex(size, r, g, b);
        data[at] = graded[0];
        data[at + 1] = graded[1];
        data[at + 2] = graded[2];
      }
    }
  }
  return { kind: '3d', size, data, domainMin: [0, 0, 0], domainMax: [1, 1, 1], title };
}

/**
 * Resample any table onto a 3D lattice. A 1D cube is a perfectly ordinary
 * thing to be handed and the filter that applies these is 3D-only, so import
 * lifts one rather than refusing it — a 1D table is just a 3D one that
 * happens to be separable.
 */
export function to3d(lut: Lut, size: number = DEFAULT_LUT_SIZE): Lut {
  if (lut.kind === '3d' && lut.size === size
    && lut.domainMin.every(v => v === 0) && lut.domainMax.every(v => v === 1)) {
    return lut;
  }
  const data = new Float32Array(size * size * size * 3);
  const step = 1 / (size - 1);
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        // Sampled in plain 0..1 input space, not across the source's declared
        // domain. Those differ: resampling over the domain would stretch the
        // input axis, so a table declaring DOMAIN_MAX 0.5 would come back
        // doing something else entirely. What matters is that the result
        // treats ordinary 0..1 video exactly as the original did, including
        // the clamping the original applied outside its own domain.
        const sampled = sampleLut(lut, [r * step, g * step, b * step]);
        const at = lutIndex(size, r, g, b);
        data[at] = sampled[0];
        data[at + 1] = sampled[1];
        data[at + 2] = sampled[2];
      }
    }
  }
  return { kind: '3d', size, data, domainMin: [0, 0, 0], domainMax: [1, 1, 1], title: lut.title };
}
