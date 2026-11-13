import { describe, it, expect } from 'vitest';
import { parseContainerTracks, normalizeTrackSelection } from './mediaTracks';

describe('container tracks', () => {
  it('reads per-type ordinals, language, titles, defaults and forced subtitles', () => {
    const tracks = parseContainerTracks(`Input #0, matroska, from 'film.mkv':
  Stream #0:0: Video: h264, yuv420p, 128x96
  Stream #0:1[0x101](eng): Audio: aac (LC), 48000 Hz, stereo (default)
    Metadata:
      title           : English stereo
  Stream #0:2(fra): Audio: ac3, 48000 Hz, 5.1
  Stream #0:3(eng): Subtitle: subrip (forced)
    Metadata:
      title           : Forced English
`);
    expect(tracks).toEqual([
      { type: 'audio', index: 1, ordinal: 0, codec: 'aac', language: 'eng', title: 'English stereo', isDefault: true, forced: false },
      { type: 'audio', index: 2, ordinal: 1, codec: 'ac3', language: 'fra', isDefault: false, forced: false },
      { type: 'subtitle', index: 3, ordinal: 0, codec: 'subrip', language: 'eng', title: 'Forced English', isDefault: false, forced: true },
    ]);
  });
  it('distinguishes keep-all from remove-all and rejects invalid selectors', () => {
    expect(normalizeTrackSelection(undefined)).toBeUndefined();
    expect(normalizeTrackSelection([])).toEqual([]);
    expect(normalizeTrackSelection([2, 0, 2])).toEqual([0, 2]);
    for (const bad of [[-1], [0.5], ['0'], null, [Infinity], Array(65).fill(0)]) expect(normalizeTrackSelection(bad)).toBeNull();
  });
});
