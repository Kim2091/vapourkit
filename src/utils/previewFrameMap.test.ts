import { describe, it, expect } from 'vitest';
import { toOutputFrame, toSourceFrame, outputFps } from './previewFrameMap';
import type { PreviewOutput } from '../electron.d';

const output = (index: number, frames: number): PreviewOutput => ({
  index, frames, width: 720, height: 480, fpsNum: 30000, fpsDen: 1001, format: 'YUV420P8',
});

// An NTSC DVD episode: 43640 frames at 29.97, and a deinterlacer after it.
const SOURCE = 43640;

describe('toOutputFrame', () => {
  it('leaves a frame alone when the step did not change the clip length', () => {
    const outputs = [output(0, SOURCE), output(1, SOURCE)];
    expect(toOutputFrame(outputs, 1, 12000)).toBe(12000);
  });

  it('reaches the end of a step that doubled the frame rate', () => {
    const outputs = [output(0, SOURCE), output(1, SOURCE * 2)];
    expect(toOutputFrame(outputs, 1, SOURCE)).toBe(SOURCE * 2 - 1);
    expect(toOutputFrame(outputs, 1, SOURCE / 2)).toBe(SOURCE);
  });

  it('reaches the end of a step that decimated', () => {
    const outputs = [output(0, SOURCE), output(1, 34912)]; // IVTC to 23.976
    expect(toOutputFrame(outputs, 1, SOURCE)).toBe(34911);
    expect(toOutputFrame(outputs, 1, 0)).toBe(0);
  });

  it('maps each output in its own space, so a comparison is of one moment', () => {
    const outputs = [output(0, SOURCE), output(1, SOURCE * 2), output(2, SOURCE * 2)];
    expect(toOutputFrame(outputs, 0, 10000)).toBe(10000);
    expect(toOutputFrame(outputs, 2, 10000)).toBe(20000);
  });

  it('clamps rather than asking for a frame past the end', () => {
    const outputs = [output(0, SOURCE), output(1, SOURCE)];
    expect(toOutputFrame(outputs, 1, SOURCE + 500)).toBe(SOURCE - 1);
    expect(toOutputFrame(outputs, 1, -20)).toBe(0);
  });

  it('passes the frame through when the outputs are not known yet', () => {
    expect(toOutputFrame([], 0, 900)).toBe(900);
  });
});

describe('toSourceFrame', () => {
  it('is the inverse of toOutputFrame across a rate change', () => {
    const outputs = [output(0, SOURCE), output(1, SOURCE * 2)];
    expect(toSourceFrame(outputs, 1, 20000)).toBe(10000);
    expect(toSourceFrame(outputs, 0, 10000)).toBe(10000);
  });

  it('does not round, so a walk along a 2x output advances every frame', () => {
    const outputs = [output(0, SOURCE), output(1, SOURCE * 2)];
    // Frames 10 and 11 of the doubled output are half a source frame apart.
    // Rounding here would collapse them onto the same source frame.
    expect(toSourceFrame(outputs, 1, 10)).toBe(5);
    expect(toSourceFrame(outputs, 1, 11)).toBe(5.5);
  });

  it('survives a round trip through a decimated step', () => {
    const outputs = [output(0, SOURCE), output(1, 34912)];
    const there = toOutputFrame(outputs, 1, 20000);
    expect(Math.round(toSourceFrame(outputs, 1, there))).toBe(20000);
  });
});

describe('outputFps', () => {
  const at = (index: number, frames: number, num: number, den: number) => ({
    ...output(index, frames), fpsNum: num, fpsDen: den,
  });

  it('uses the output own rate', () => {
    const outputs = [at(0, SOURCE, 30000, 1001), at(1, SOURCE * 2, 60000, 1001)];
    expect(outputFps(outputs, 1, 29.97)).toBeCloseTo(59.94, 2);
  });

  it('scales the source rate when a node reports no rate', () => {
    const outputs = [at(0, SOURCE, 30000, 1001), at(1, SOURCE * 2, 0, 1)];
    expect(outputFps(outputs, 1, 29.97)).toBeCloseTo(59.94, 2);
  });

  it('falls back to the source rate for an unknown output', () => {
    expect(outputFps([], 3, 23.976)).toBe(23.976);
  });
});
