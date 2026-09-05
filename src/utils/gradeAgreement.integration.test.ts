// Does the shipped Color Grade template render what the preview promises?
//
// colorGrade.test.ts compares a mirror of this template's expression building
// against the reference. The mirror is hand-written, so it can drift from the
// template without anything failing — which is exactly the gap that matters,
// because the template is what actually renders. This closes it by running the
// real .vkfilter through real VapourSynth.
//
// Skipped where the portable VapourSynth is not installed.

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import { spawnSync } from 'child_process';

import { gradePixel, GRADE_NEUTRAL, type GradeValues } from './colorGrade';

const repo = path.resolve(__dirname, '..', '..');
const python = path.join(repo, 'data', 'vapoursynth-portable',
  process.platform === 'win32' ? 'python.exe' : path.join('bin', 'python3'));
const template = path.join(repo, 'include', 'filter_templates', 'Color Grade.vkfilter');
const verifier = path.join(repo, 'scripts', 'verify_grade.py');

const installed = fs.existsSync(python) && fs.existsSync(verifier);

describe.skipIf(!installed)('Color Grade template, against real VapourSynth', () => {
  it('renders the pixels the reference predicts', () => {
    // Every control off its default, so a mistake in any one term shows up.
    const values: GradeValues = {
      ...GRADE_NEUTRAL,
      lift: { r: 0.02, g: 0, b: -0.015, m: 0.05 },
      gamma: { r: 1.1, g: 1, b: 0.95, m: 1.2 },
      gain: { r: 1.05, g: 1, b: 0.9, m: 0.85 },
      offset: { r: 0.01, g: 0, b: 0.005, m: -0.02 },
      temperature: 800,
      tint: -12,
      contrast: 1.15,
      pivot: 0.435,
      saturation: 1.25,
      hue: 7.5,
      brightness: 0.03,
    };

    const pixels: [number, number, number][] = [
      [0, 0, 0], [1, 1, 1], [0.5, 0.5, 0.5], [0.6, 0.4, 0.25],
      [0.05, 0.9, 0.33], [0.82, 0.12, 0.55], [0.2, 0.2, 0.2],
    ];

    const referencePath = path.join(os.tmpdir(), `vk-grade-ref-${process.pid}.json`);
    fs.writeJsonSync(referencePath, {
      values,
      pixels,
      expected: pixels.map(pixel => gradePixel(pixel, values)),
    });

    try {
      const result = spawnSync(python, [verifier, referencePath, template], {
        encoding: 'utf-8',
        cwd: repo,
      });

      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      expect(result.status, output).toBe(0);
      // Float32 through VapourSynth against float64 in JavaScript, so the
      // agreement is to single precision rather than exact.
      expect(output, output).toContain('AGREE');
    } finally {
      fs.removeSync(referencePath);
    }
  }, 120000);
});
