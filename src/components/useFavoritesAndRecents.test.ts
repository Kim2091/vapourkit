import { describe, expect, it } from 'vitest';
import { MAX_RECENT, normalizeRecents, pushRecent, serializeRecents } from './useFavoritesAndRecents';

describe('normalizeRecents', () => {
  it('reads entries under the given field, newest first', () => {
    const stored = [{ path: '/a', lastUsed: 1 }, { path: '/b', lastUsed: 3 }];
    expect(normalizeRecents(stored, 'path')).toEqual([{ key: '/b', lastUsed: 3 }, { key: '/a', lastUsed: 1 }]);
  });

  it('reads plain strings as entries last used at 0, and drops duplicates and junk', () => {
    const stored = ['Deband', { name: 'Deband', lastUsed: 9 }, { name: 'Crop', lastUsed: 2 }, 42, null, { other: 'x' }];
    expect(normalizeRecents(stored, 'name')).toEqual([{ key: 'Crop', lastUsed: 2 }, { key: 'Deband', lastUsed: 0 }]);
  });

  it('keeps at most MAX_RECENT', () => {
    const stored = Array.from({ length: MAX_RECENT + 5 }, (_, i) => ({ name: `f${i}`, lastUsed: i }));
    const result = normalizeRecents(stored, 'name');
    expect(result).toHaveLength(MAX_RECENT);
    expect(result[0].key).toBe(`f${MAX_RECENT + 4}`);
  });

  it('answers an empty list for anything but an array', () => {
    expect(normalizeRecents({ name: 'x' }, 'name')).toEqual([]);
  });
});

describe('serializeRecents', () => {
  it('writes the stored format: the field first, then lastUsed', () => {
    expect(serializeRecents([{ key: '/m/a.onnx', lastUsed: 5 }], 'path')).toBe('[{"path":"/m/a.onnx","lastUsed":5}]');
    expect(serializeRecents([{ key: 'Crop', lastUsed: 5 }], 'name')).toBe('[{"name":"Crop","lastUsed":5}]');
  });

  it('round-trips through normalizeRecents', () => {
    const recents = [{ key: 'b', lastUsed: 2 }, { key: 'a', lastUsed: 1 }];
    expect(normalizeRecents(JSON.parse(serializeRecents(recents, 'name')), 'name')).toEqual(recents);
  });
});

describe('pushRecent', () => {
  it('moves an item to the front without duplicating it', () => {
    const recents = [{ key: 'a', lastUsed: 2 }, { key: 'b', lastUsed: 1 }];
    expect(pushRecent(recents, 'b', 10)).toEqual([{ key: 'b', lastUsed: 10 }, { key: 'a', lastUsed: 2 }]);
  });

  it('drops the oldest past MAX_RECENT', () => {
    const recents = Array.from({ length: MAX_RECENT }, (_, i) => ({ key: `k${i}`, lastUsed: MAX_RECENT - i }));
    const result = pushRecent(recents, 'new', 99);
    expect(result).toHaveLength(MAX_RECENT);
    expect(result[0].key).toBe('new');
    expect(result.some(entry => entry.key === `k${MAX_RECENT - 1}`)).toBe(false);
  });
});
