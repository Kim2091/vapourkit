import { describe, expect, it } from 'vitest';
import { audioTrimFor, parseTimecodesV2, timecodesPathFor, videoTimescaleFor } from './sourceTiming';

// 24 fps for 4 frames, then 30 fps, as BestSource writes it (milliseconds, two decimals).
const VFR = '# timecode format v2\r\n0.00\r\n41.67\r\n83.33\r\n125.00\r\n166.67\r\n200.00\r\n233.33\r\n';

describe('timecodes', () => {
  it('sit beside the script', () => {
    expect(timecodesPathFor('C:\\Temp\\VSR_upscale_1_ab.vpy')).toBe('C:\\Temp\\VSR_upscale_1_ab.timecodes.txt');
  });

  it('parse to seconds', () => {
    const expected = [0, 0.04167, 0.08333, 0.125, 0.16667, 0.2, 0.23333];
    const times = parseTimecodesV2(VFR);
    expect(times).toHaveLength(expected.length);
    times.forEach((t, i) => expect(t).toBeCloseTo(expected[i], 9));
  });

  it('parse to nothing when a line is not a number', () => {
    expect(parseTimecodesV2('# timecode format v2\n0.00\nscript\n')).toEqual([]);
    expect(parseTimecodesV2('')).toEqual([]);
  });
});

describe('the audio trim', () => {
  const times = parseTimecodesV2(VFR);

  it('is none for a full run whose video starts with the file', () => {
    expect(audioTrimFor(times, 0)).toEqual({ start: null, duration: null, exact: true });
  });

  it('cuts the lead of audio before a video that starts later', () => {
    const late = times.map(t => t + 0.5);
    expect(audioTrimFor(late, 0)).toEqual({ start: 0.5, duration: null, exact: true });
    // ffmpeg counts -ss from the file's start, the earliest stream.
    expect(audioTrimFor(late, 0.2).start).toBeCloseTo(0.3, 9);
  });

  it('uses the source timestamps of a segment\'s first frame and of the frame after its last', () => {
    const trim = audioTrimFor(times, 0, { enabled: true, startFrame: 2, endFrame: 6 });
    expect(trim.exact).toBe(true);
    expect(trim.start).toBeCloseTo(0.08333, 9);
    expect(trim.duration).toBeCloseTo(0.23333 - 0.08333, 9);
  });

  it('runs a segment to the end of the file when it ends at the last frame', () => {
    const toEnd = audioTrimFor(times, 0, { enabled: true, startFrame: 4, endFrame: -1 });
    expect(toEnd.start).toBeCloseTo(0.16667, 9);
    expect(toEnd.duration).toBeNull();
    expect(audioTrimFor(times, 0, { enabled: true, startFrame: 4, endFrame: 7 }).duration).toBeNull();
  });

  it('falls back to frame / fps without timecodes', () => {
    expect(audioTrimFor([], 0, { enabled: true, startFrame: 48, endFrame: 96 }, 24)).toEqual({ start: 2, duration: 2, exact: false });
    expect(audioTrimFor([], 0, undefined, 24)).toEqual({ start: null, duration: null, exact: false });
  });
});

describe('the output video time base', () => {
  it('lands every frame of a constant rate exactly', () => {
    expect(videoTimescaleFor('24000/1001', false)).toBe(24000);
    expect(videoTimescaleFor('30000/1001', false)).toBe(30000);
    expect(videoTimescaleFor('30/1', false)).toBe(15360);
    expect(videoTimescaleFor('25/1', false)).toBe(12800);
  });

  it('is microseconds for a variable rate, or a rate with no small numerator', () => {
    expect(videoTimescaleFor('107000000/3966667', true)).toBe(1000000);
    expect(videoTimescaleFor('107000000/3966667', false)).toBe(1000000);
    expect(videoTimescaleFor(null, false)).toBe(1000000);
  });
});
