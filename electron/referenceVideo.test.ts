import { describe, expect, it } from 'vitest';
import { encodeReferenceVideo, parseReferenceVideo, referenceVideoName } from './referenceVideo';

describe('reference video values', () => {
  it('round-trips a path with quotes, colons and backslashes', () => {
    const video = { path: 'D:\\dvd\\ep01: "remux".mkv', offset: -3 };
    expect(parseReferenceVideo(encodeReferenceVideo(video))).toEqual(video);
  });

  it('is null for a step id, the source, and anything malformed', () => {
    expect(parseReferenceVideo('custom-0')).toBeNull();
    expect(parseReferenceVideo('')).toBeNull();
    expect(parseReferenceVideo(undefined)).toBeNull();
    expect(parseReferenceVideo('file:not json')).toBeNull();
    expect(parseReferenceVideo('file:{"offset":2}')).toBeNull();
  });

  it('keeps offsets whole', () => {
    expect(parseReferenceVideo(encodeReferenceVideo({ path: 'a.mkv', offset: 2.7 }))?.offset).toBe(2);
    expect(parseReferenceVideo('file:{"path":"a.mkv","offset":"x"}')?.offset).toBe(0);
  });

  it('names the file without its folder', () => {
    expect(referenceVideoName({ path: 'C:\\a\\b\\ep 01.mkv', offset: 0 })).toBe('ep 01.mkv');
    expect(referenceVideoName({ path: '/home/k/ep.mkv', offset: 0 })).toBe('ep.mkv');
  });
});
