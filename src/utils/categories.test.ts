import { describe, expect, it } from 'vitest';
import { toCategories } from './categories';

describe('toCategories', () => {
  it('passes a list through', () => {
    const list = ['A', 'B'];
    expect(toCategories(list)).toBe(list);
  });

  it('wraps a single category', () => {
    expect(toCategories('A')).toEqual(['A']);
  });

  it('answers the fallback, or nothing, when there is no category', () => {
    expect(toCategories(undefined)).toEqual([]);
    expect(toCategories('')).toEqual([]);
    expect(toCategories(null, ['Uncategorized'])).toEqual(['Uncategorized']);
  });

  it('keeps an empty list empty rather than using the fallback', () => {
    expect(toCategories([], ['Uncategorized'])).toEqual([]);
  });
});
