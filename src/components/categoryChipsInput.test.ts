import { describe, expect, it } from 'vitest';
import { addCategory, categoryForEnter } from './CategoryChipsInput';

describe('addCategory', () => {
  it('adds the trimmed text once', () => {
    expect(addCategory(['A'], '  B ')).toEqual(['A', 'B']);
    const same = ['A'];
    expect(addCategory(same, 'A')).toBe(same);
    expect(addCategory(same, '   ')).toBe(same);
  });
});

describe('categoryForEnter', () => {
  const suggestions = ['Anime', 'Live Action'];
  it('prefers the suggestion the text names, ignoring case', () => {
    expect(categoryForEnter(' anime ', [], suggestions)).toBe('Anime');
  });
  it('otherwise takes the text', () => {
    expect(categoryForEnter('New', [], suggestions)).toBe('New');
  });
  it('with no text, takes the first suggestion not chosen yet', () => {
    expect(categoryForEnter('', ['Anime'], suggestions)).toBe('Live Action');
    expect(categoryForEnter('', suggestions, suggestions)).toBeUndefined();
  });
});
