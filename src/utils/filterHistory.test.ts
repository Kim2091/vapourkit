import { describe, it, expect } from 'vitest';
import { MAX_HISTORY_SIZE, recordFilters, redoFilters, startHistory, undoFilters } from './filterHistory';
import type { Filter } from '../electron.d';

const chain = (...ids: string[]): Filter[] =>
  ids.map((id, order) => ({ id, enabled: true, filterType: 'custom', preset: id, code: '', order }));

describe('filter history', () => {
  it('undoes and redoes recorded changes in order', () => {
    let history = startHistory(chain('a'));
    history = recordFilters(history, chain('a', 'b'));
    history = recordFilters(history, chain('a', 'b', 'c'));

    history = undoFilters(history);
    expect(history.present).toEqual(chain('a', 'b'));
    history = undoFilters(history);
    expect(history.present).toEqual(chain('a'));
    expect(undoFilters(history)).toBe(history);

    history = redoFilters(history);
    expect(history.present).toEqual(chain('a', 'b'));
    history = redoFilters(history);
    expect(history.present).toEqual(chain('a', 'b', 'c'));
    expect(redoFilters(history)).toBe(history);
  });

  it('drops the redo steps when a new change is recorded', () => {
    let history = recordFilters(startHistory(chain('a')), chain('b'));
    history = recordFilters(undoFilters(history), chain('c'));
    expect(history.future).toEqual([]);
    expect(history.past).toEqual([chain('a')]);
  });

  it('records nothing for a chain equal to the present one', () => {
    const history = startHistory(chain('a'));
    expect(recordFilters(history, chain('a'))).toBe(history);
  });

  it('keeps at most MAX_HISTORY_SIZE undo steps', () => {
    let history = startHistory(chain('0'));
    for (let n = 1; n <= MAX_HISTORY_SIZE + 5; n++) history = recordFilters(history, chain(String(n)));
    expect(history.past).toHaveLength(MAX_HISTORY_SIZE);
    expect(history.past[0]).toEqual(chain('5'));
  });
});
