import { describe, expect, it } from 'vitest';
import { groupByCategories, matchesQuery, sortByName } from './pickerFilters';

describe('matchesQuery', () => {
  it('matches a substring of any string or list value', () => {
    expect(matchesQuery('deb', 'Deband')).toBe(true);
    expect(matchesQuery('geo', 'Crop', undefined, ['Restore', 'Geometry'])).toBe(true);
    expect(matchesQuery('zzz', 'Crop', '', null, ['a'])).toBe(false);
  });
});

describe('groupByCategories', () => {
  it('lists an item under each category once, in item order', () => {
    const items = [{ k: 'a', c: ['X', 'Y', 'X'] }, { k: 'b', c: ['X'] }, { k: 'a', c: ['X'] }];
    const groups = groupByCategories(items, item => item.c, item => item.k);
    expect(Object.keys(groups)).toEqual(['X', 'Y']);
    expect(groups.X.map(item => item.k)).toEqual(['a', 'b']);
    expect(groups.Y.map(item => item.k)).toEqual(['a']);
  });
});

describe('sortByName', () => {
  it('sorts a copy and leaves the input alone', () => {
    const items = [{ name: 'b' }, { name: 'a' }];
    expect(sortByName(items).map(item => item.name)).toEqual(['a', 'b']);
    expect(items.map(item => item.name)).toEqual(['b', 'a']);
  });
});
