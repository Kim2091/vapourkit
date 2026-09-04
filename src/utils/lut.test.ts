// The two things that silently corrupt a LUT are channel ordering and value
// scaling, and neither shows up as an error — the file loads, the picture is
// just wrong. So the tables below are deliberately asymmetric: a red-only
// ramp read back through a transposed loop lands in blue, and a test that
// used a symmetric table would pass either way.

import { describe, it, expect } from 'vitest';
import {
  parseCube, writeCube, parse3dl, write3dl, parseLut, writeLut,
  identityLut, sampleLut, lutIndex, bakeGradeToLut, to3d, LutParseError,
  type Lut,
} from './lut';
import { gradePixel, GRADE_NEUTRAL, type GradeValues } from './colorGrade';

/** A table whose output depends on exactly one input channel. */
function rampOn(channel: 0 | 1 | 2, size: number): Lut {
  const lut = identityLut(size);
  const step = 1 / (size - 1);
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const at = lutIndex(size, r, g, b);
        const source = [r, g, b][channel] * step;
        lut.data[at] = lut.data[at + 1] = lut.data[at + 2] = source;
      }
    }
  }
  return lut;
}

const GRADE: GradeValues = {
  ...GRADE_NEUTRAL,
  lift: { r: 0.02, g: -0.01, b: 0.03, m: 0.01 },
  gamma: { r: 1.1, g: 1.0, b: 0.92, m: 1.0 },
  gain: { r: 1.05, g: 1.0, b: 0.96, m: 1.02 },
  temperature: 800, tint: -4, contrast: 1.12, saturation: 1.15, hue: 3, brightness: 0.02,
};

describe('.cube', () => {
  it('round-trips a table through text unchanged', () => {
    const original = bakeGradeToLut(GRADE, 9, 'Round trip');
    const back = parseCube(writeCube(original));
    expect(back.kind).toBe('3d');
    expect(back.size).toBe(9);
    expect(back.title).toBe('Round trip');
    for (let i = 0; i < original.data.length; i++) {
      expect(back.data[i]).toBeCloseTo(original.data[i], 5);
    }
  });

  it('writes red as the fastest-changing channel', () => {
    const rows = writeCube(rampOn(0, 3)).split('\n')
      .filter(line => /^[\d.]/.test(line))
      .map(line => Number(line.split(' ')[0]));
    // Red fastest: the first three rows walk red from 0 to 1 with g and b at 0.
    expect(rows.slice(0, 3)).toEqual([0, 0.5, 1]);
  });

  it('reads the channel a ramp was written on back on the same channel', () => {
    for (const channel of [0, 1, 2] as const) {
      const back = parseCube(writeCube(rampOn(channel, 5)));
      const probe: [number, number, number] = [0.75, 0.5, 0.25];
      const sampled = sampleLut(back, probe);
      expect(sampled[0]).toBeCloseTo(probe[channel], 5);
    }
  });

  it('keeps comments, titles and a declared domain', () => {
    const lut = parseCube([
      '# a comment',
      'TITLE "Half domain"',
      'LUT_3D_SIZE 2',
      'DOMAIN_MIN 0.0 0.0 0.0',
      'DOMAIN_MAX 0.5 0.5 0.5',
      ...Array.from({ length: 8 }, () => '0.0 0.0 0.0'),
    ].join('\n'));
    expect(lut.title).toBe('Half domain');
    expect(lut.domainMax).toEqual([0.5, 0.5, 0.5]);
  });

  it('names what is wrong rather than loading a broken table', () => {
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 0')).toThrow(/needs 8 rows, found 1/);
    expect(() => parseCube('0.0 0.0 0.0')).toThrow(/not a .cube file/);
    expect(() => parseCube('LUT_3D_SIZE 1\n')).toThrow(/outside the 2\.\.256/);
    expect(() => parseCube('LUT_3D_SIZE 2\nWAT 1 2\n')).toThrow(/unrecognised keyword "WAT"/);
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 nope\n')).toThrow(/"nope" is not a number/);
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 nope\n')).toThrow(LutParseError);
  });

  it('reports the line a bad row is on', () => {
    try {
      parseCube('LUT_3D_SIZE 2\n\n0 0 0\n0 0 oops\n');
      expect.unreachable();
    } catch (error) {
      expect((error as LutParseError).line).toBe(4);
    }
  });
});

describe('.3dl', () => {
  it('writes blue as the fastest-changing channel, unlike .cube', () => {
    const text = write3dl(rampOn(2, 3), 12);
    // Rows only: "3DMESH" also begins with a digit, and the ramp is dropped.
    const rows = text.split('\n')
      .filter(l => /^\d+( \d+)+$/.test(l))
      .slice(1)
      .map(l => Number(l.split(' ')[0]));
    // Blue fastest, and the table ramps on blue, so the first three rows walk
    // 0 to full scale. The same table written as .cube would not.
    expect(rows.slice(0, 3)).toEqual([0, 2048, 4095]);
  });

  it('transposes back on read, so a ramp survives the round trip', () => {
    for (const channel of [0, 1, 2] as const) {
      const back = parse3dl(write3dl(rampOn(channel, 5), 16));
      const probe: [number, number, number] = [0.75, 0.5, 0.25];
      expect(sampleLut(back, probe)[0]).toBeCloseTo(probe[channel], 4);
    }
  });

  it('infers the bit depth from the largest value present', () => {
    const size = 2;
    const body = Array.from({ length: size ** 3 }, () => '0 0 1023').join('\n');
    const lut = parse3dl(`0 1023\n${body}`);
    // 1023 is full scale at 10 bits, so it reads as 1.0 and not as 1023/65535.
    expect(lut.data[2]).toBeCloseTo(1, 6);
  });

  it('survives a Lustre-style header', () => {
    const body = Array.from({ length: 8 }, () => '0 0 0').join('\n');
    expect(() => parse3dl(`3DMESH\nMesh 1 12\n0 4095\n${body}\n`)).not.toThrow();
  });

  it('refuses what it cannot represent', () => {
    expect(() => write3dl(identityLut(4, '1d'))).toThrow(/3D tables only/);
    // A file with no ramp would otherwise have its first entry eaten as one.
    expect(() => parse3dl('0 0 0\n')).toThrow(/must be an ascending input ramp/);
    expect(() => parse3dl('# nothing but a comment\n')).toThrow(/not a .3dl file/);
    expect(() => parse3dl('0 2048 4095\n0 0 0\n')).toThrow(/needs 27 rows/);
    expect(() => parse3dl('0 2048 4095\n' + Array.from({ length: 27 }, () => '0 0 -1').join('\n')))
      .toThrow(/unsigned integers/);
  });

  it('crosses formats within its own quantisation', () => {
    const original = bakeGradeToLut(GRADE, 9);
    const crossed = parse3dl(write3dl(original, 16));
    for (let i = 0; i < original.data.length; i++) {
      expect(crossed.data[i]).toBeCloseTo(original.data[i], 4);
    }
  });
});

describe('parseLut / writeLut', () => {
  it('picks the reader from the file name', () => {
    const cube = writeCube(identityLut(3));
    expect(parseLut(cube, 'Some Look.CUBE').size).toBe(3);
    expect(parseLut(write3dl(identityLut(3)), 'x.3dl').size).toBe(3);
    expect(() => parseLut(cube, 'look.icc')).toThrow(/reads \.cube and \.3dl/);
  });

  it('writes whichever format was asked for', () => {
    expect(writeLut(identityLut(2), 'cube')).toContain('LUT_3D_SIZE 2');
    expect(writeLut(identityLut(2), '3dl')).not.toContain('LUT_3D_SIZE');
  });
});

describe('sampleLut', () => {
  it('leaves the picture alone for an identity table', () => {
    const lut = identityLut(17);
    for (const probe of [[0, 0, 0], [1, 1, 1], [0.5, 0.25, 0.75], [0.13, 0.87, 0.4]] as const) {
      const out = sampleLut(lut, probe);
      for (let c = 0; c < 3; c++) expect(out[c]).toBeCloseTo(probe[c], 6);
    }
  });

  it('clamps outside the domain rather than reading past the table', () => {
    const lut = identityLut(5);
    expect(sampleLut(lut, [-1, 2, 0.5])).toEqual([0, 1, 0.5]);
  });

  it('applies a 1D table per channel', () => {
    const lut = identityLut(3, '1d');
    lut.data[3] = 0.9; // midpoint of red only
    expect(sampleLut(lut, [0.5, 0.5, 0.5])[0]).toBeCloseTo(0.9, 6);
    expect(sampleLut(lut, [0.5, 0.5, 0.5])[1]).toBeCloseTo(0.5, 6);
  });
});

describe('bakeGradeToLut', () => {
  it('bakes a neutral grade to an identity table', () => {
    const lut = bakeGradeToLut(GRADE_NEUTRAL, 17);
    const reference = identityLut(17);
    for (let i = 0; i < lut.data.length; i++) {
      expect(lut.data[i]).toBeCloseTo(reference.data[i], 6);
    }
  });

  it('reproduces the grade to within the lattice it was given', () => {
    // What a 3D table costs is interpolation error, and it is worth measuring
    // rather than assuming — the first guess here was out by a factor of ten.
    //
    // Over a deterministic sweep of the cube the worst channel error is about
    // 5.6/255 at size 17 and 2.9/255 at 33, with a mean of 0.06/255. The
    // interesting part is that it falls roughly LINEARLY with size, not with
    // its square: that is the signature of a kink rather than curvature, and
    // the kink is the clamp inside channel(). Where a channel clips, the
    // grade has a hard corner and trilinear interpolation cuts across it, so
    // doubling the lattice only halves the error. Every 3D LUT has this; it
    // is why the peak lives in blown highlights and the mean stays tiny.
    //
    // 33 is the default offered because it is the size everything else ships
    // and its mean error is a fortieth of a code value; 65 is there for
    // anyone who wants the clipped corners tighter.
    const worst = (size: number) => {
      const lut = bakeGradeToLut(GRADE, size);
      let peak = 0;
      const steps = 23; // coprime with the lattice sizes, so probes land off-node
      for (let i = 0; i <= steps; i++) {
        for (let j = 0; j <= steps; j++) {
          for (let k = 0; k <= steps; k++) {
            const probe: [number, number, number] = [i / steps, j / steps, k / steps];
            const exact = gradePixel(probe, GRADE);
            const viaLut = sampleLut(lut, probe);
            for (let c = 0; c < 3; c++) peak = Math.max(peak, Math.abs(exact[c] - viaLut[c]));
          }
        }
      }
      return peak * 255;
    };

    const at17 = worst(17);
    const at33 = worst(33);
    const at65 = worst(65);
    expect(at17).toBeLessThan(7);
    expect(at33).toBeLessThan(4);
    expect(at65).toBeLessThan(2);
    expect(at33).toBeLessThan(at17);
    expect(at65).toBeLessThan(at33);
  });

  it('refuses a size no format can carry', () => {
    expect(() => bakeGradeToLut(GRADE, 1)).toThrow(/not a usable cube size/);
    expect(() => bakeGradeToLut(GRADE, 300)).toThrow(/not a usable cube size/);
    expect(() => bakeGradeToLut(GRADE, 16.5)).toThrow(/not a usable cube size/);
  });
});

describe('to3d', () => {
  it('lifts a 1D table onto a lattice without changing what it does', () => {
    const oneD = identityLut(9, '1d');
    for (let i = 0; i < 9; i++) oneD.data[i * 3] = Math.pow(i / 8, 2.2); // red only
    const lifted = to3d(oneD, 17);
    expect(lifted.kind).toBe('3d');
    for (const probe of [[0.25, 0.5, 0.75], [0.9, 0.1, 0.4]] as const) {
      const before = sampleLut(oneD, probe);
      const after = sampleLut(lifted, probe);
      for (let c = 0; c < 3; c++) expect(after[c]).toBeCloseTo(before[c], 2);
    }
  });

  it('folds a declared domain into a plain 0..1 table', () => {
    const half = identityLut(5);
    half.domainMax = [0.5, 0.5, 0.5];
    const flat = to3d(half, 9);
    expect(flat.domainMax).toEqual([1, 1, 1]);
    // Input 0.5 hit the top of the old domain, so it still reads as full scale.
    expect(sampleLut(flat, [0.5, 0.5, 0.5])[0]).toBeCloseTo(sampleLut(half, [0.5, 0.5, 0.5])[0], 5);
  });

  it('hands back a table that is already what was asked for', () => {
    const already = identityLut(33);
    expect(to3d(already, 33)).toBe(already);
  });
});

describe('.3dl value scaling', () => {
  // The other silent corruptor this file's header names. The ordering tests
  // above use asymmetric tables; these use dark ones, because a table that
  // never gets bright is where an inferred bit depth goes wrong — and every
  // .3dl fixture above happens to saturate, which is why this went unnoticed.
  const darken = (m: number) => ({ ...GRADE_NEUTRAL, gain: { r: 1, g: 1, b: 1, m } });

  it('round-trips a table that never reaches full scale', () => {
    for (const gain of [0.9, 0.2501, 0.2499, 0.06, 0.01]) {
      const baked = bakeGradeToLut(darken(gain), 17);
      const back = parse3dl(write3dl(baked, 12));
      let worst = 0;
      for (let i = 0; i < baked.data.length; i++) {
        worst = Math.max(worst, Math.abs(back.data[i] - baked.data[i]));
      }
      // Quantisation at 12 bits, and nothing else. Before the depth was
      // stated in the file this was 168/255 at gain 0.22.
      expect(worst * 255).toBeLessThan(0.5);
    }
  });

  it('states the output depth rather than leaving it to be guessed', () => {
    const text = write3dl(identityLut(3), 12);
    expect(text).toMatch(/^Mesh 12 12$/m);
    expect(text).toContain('3DMESH');
  });

  it('believes a declared depth over the table it is reading', () => {
    // Values that would infer as 10-bit, declared as 12-bit.
    const body = Array.from({ length: 8 }, () => '0 0 1023').join('\n');
    expect(parse3dl(`3DMESH\nMesh 12 12\n0 4095\n${body}`).data[2]).toBeCloseTo(1023 / 4095, 6);
    expect(parse3dl(`3DMESH\nMesh 10 10\n0 1023\n${body}`).data[2]).toBeCloseTo(1, 6);
  });

  it('falls back to the ramp before the table when no depth is declared', () => {
    const body = Array.from({ length: 8 }, () => '0 0 500').join('\n');
    // The ramp tops out at 4095, so the table is 12-bit even though its own
    // largest value would have inferred 10.
    expect(parse3dl(`0 4095\n${body}`).data[2]).toBeCloseTo(500 / 4095, 6);
  });
});
