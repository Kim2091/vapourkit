import { describe, it, expect } from 'vitest';
import { parseBestSourceProgress } from './bestSourceProgressParser';

describe('parseBestSourceProgress', () => {
  it('returns empty array for chunks with no progress lines', () => {
    expect(parseBestSourceProgress('some unrelated stderr text')).toEqual([]);
    expect(parseBestSourceProgress('')).toEqual([]);
  });

  it('extracts percentage from a single progress line', () => {
    const chunk = 'VideoSource track #0 index progress 47%';
    expect(parseBestSourceProgress(chunk)).toEqual([47]);
  });

  it('extracts multiple percentages from a multi-line chunk', () => {
    const chunk = [
      'VideoSource track #0 index progress 10%',
      'VideoSource track #0 index progress 20%',
      'VideoSource track #0 index progress 30%',
    ].join('\n');
    expect(parseBestSourceProgress(chunk)).toEqual([10, 20, 30]);
  });

  it('matches lines with VapourSynth log-level prefixes', () => {
    const chunk = 'Information: VideoSource track #0 index progress 75%';
    expect(parseBestSourceProgress(chunk)).toEqual([75]);
  });

  it('matches any track number', () => {
    const chunk = 'VideoSource track #3 index progress 50%';
    expect(parseBestSourceProgress(chunk)).toEqual([50]);
  });

  it('ignores the MB variant (unknown filesize case)', () => {
    const chunk = 'VideoSource track #0 index progress 123MB';
    expect(parseBestSourceProgress(chunk)).toEqual([]);
  });

  it('ignores non-progress BestSource lines', () => {
    expect(parseBestSourceProgress('VideoSource track #0 indexing complete')).toEqual([]);
    expect(parseBestSourceProgress('VideoSource track #0 using CPU decoding fallback')).toEqual([]);
  });

  it('clamps percentages to 0-100 range', () => {
    expect(parseBestSourceProgress('VideoSource track #0 index progress 150%')).toEqual([100]);
  });

  it('handles a chunk that mixes progress lines with unrelated noise', () => {
    const chunk = [
      'random noise',
      'VideoSource track #0 index progress 25%',
      'more noise',
      'VideoSource track #0 index progress 50%',
      'unrelated',
    ].join('\n');
    expect(parseBestSourceProgress(chunk)).toEqual([25, 50]);
  });

  it('is safe to call multiple times on the same string (lastIndex reset)', () => {
    const chunk = 'VideoSource track #0 index progress 42%';
    expect(parseBestSourceProgress(chunk)).toEqual([42]);
    expect(parseBestSourceProgress(chunk)).toEqual([42]);
    expect(parseBestSourceProgress(chunk)).toEqual([42]);
  });

  it('does not match negative percentages (regex rejects them, no clamp triggered)', () => {
    expect(parseBestSourceProgress('VideoSource track #0 index progress -5%')).toEqual([]);
  });
});
