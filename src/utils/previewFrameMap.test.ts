import { describe, it, expect } from 'vitest';
import { toOutputFrame } from './previewFrameMap';
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
