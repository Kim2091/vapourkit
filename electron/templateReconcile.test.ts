import { describe, expect, it } from 'vitest';
import { planTemplateReconcile, releaseForVersion, type TemplateState, type TemplateTables } from './templateReconcile';

const tables: TemplateTables = {
  history: {
    'A.vkfilter': ['a1', 'a2'],
    'Old.vkfilter': ['o1'],
    'Renamed.vkfilter': ['r1'],
  },
  releases: {
    '2.0.0': { 'A.vkfilter': 'a1', 'Old.vkfilter': 'o1' },
  },
  renames: { 'Renamed.vkfilter': 'New.vkfilter' },
};

function state(partial: Partial<TemplateState>): TemplateState {
  return {
    bundled: new Map([['A.vkfilter', 'a2']]),
    shippedAnywhere: new Set(['A.vkfilter']),
    installed: new Map(),
    ledger: {},
    ...partial,
  };
}

const plan = (partial: Partial<TemplateState>) => planTemplateReconcile(state(partial), tables);

describe('template reconcile', () => {
  it('seeds a template the install never had', () => {
    expect(plan({})).toEqual([{ kind: 'seed', file: 'A.vkfilter' }]);
  });

  it('does not bring back a template the user deleted', () => {
    expect(plan({ ledger: { 'A.vkfilter': { digest: 'a1', appVersion: '2.1.0' } } })).toEqual([]);
  });

  it('replaces an untouched template we changed, with or without a ledger', () => {
    expect(plan({ installed: new Map([['A.vkfilter', 'a1']]) })).toEqual([{ kind: 'update', file: 'A.vkfilter' }]);
    expect(plan({
      installed: new Map([['A.vkfilter', 'a1']]),
      ledger: { 'A.vkfilter': { digest: 'a1', appVersion: '2.0.0' } },
    })).toEqual([{ kind: 'update', file: 'A.vkfilter' }]);
  });

  it('records the base of a current template the ledger does not know yet', () => {
    expect(plan({ installed: new Map([['A.vkfilter', 'a2']]) }))
      .toEqual([{ kind: 'record', file: 'A.vkfilter', digest: 'a2' }]);
  });

  it('asks about an edit we have changed underneath', () => {
    expect(plan({
      installed: new Map([['A.vkfilter', 'mine']]),
      ledger: { 'A.vkfilter': { digest: 'a1', appVersion: '2.0.0' } },
    })).toEqual([{ kind: 'edited-outdated', file: 'A.vkfilter' }]);
  });

  it('says nothing about an edit of the current body', () => {
    expect(plan({
      installed: new Map([['A.vkfilter', 'mine']]),
      ledger: { 'A.vkfilter': { digest: 'a2', appVersion: '2.1.0' } },
    })).toEqual([]);
  });

  it('takes a pre-ledger edit as based on the release it was running', () => {
    const edited = { installed: new Map([['A.vkfilter', 'mine']]) };
    expect(plan({ ...edited, previousVersion: '2.0.0' })).toEqual([{ kind: 'edited-outdated', file: 'A.vkfilter' }]);
    expect(plan({ ...edited, previousVersion: '2.0.0-nightly.2026-09-17' })).toEqual([{ kind: 'edited-outdated', file: 'A.vkfilter' }]);
    // A release that already shipped the current body: the edit is of that.
    expect(planTemplateReconcile(state({ ...edited, previousVersion: '2.1.0' }), {
      ...tables, releases: { '2.1.0': { 'A.vkfilter': 'a2' } },
    })).toEqual([{ kind: 'record', file: 'A.vkfilter', digest: 'a2' }]);
  });

  it('asks when nothing says what an edit started from', () => {
    expect(plan({ installed: new Map([['A.vkfilter', 'mine']]) })).toEqual([{ kind: 'edited-outdated', file: 'A.vkfilter' }]);
  });

  it('removes an untouched template no longer shipped, and asks about an edited one', () => {
    expect(plan({ installed: new Map([['A.vkfilter', 'a2'], ['Old.vkfilter', 'o1']]) }))
      .toContainEqual({ kind: 'remove', file: 'Old.vkfilter' });
    expect(plan({ installed: new Map([['A.vkfilter', 'a2'], ['Renamed.vkfilter', 'mine']]), previousVersion: '2.0.0' }))
      .toContainEqual({ kind: 'edited-dropped', file: 'Renamed.vkfilter', replacement: 'New.vkfilter' });
  });

  it('stops asking about a dropped template the user chose to keep', () => {
    expect(plan({
      installed: new Map([['A.vkfilter', 'a2'], ['Old.vkfilter', 'mine']]),
      ledger: {
        'A.vkfilter': { digest: 'a2', appVersion: '2.1.0' },
        'Old.vkfilter': { digest: 'mine', appVersion: '2.1.0', keptDropped: true },
      },
    })).toEqual([]);
  });

  it('never touches a template the user made', () => {
    expect(plan({ installed: new Map([['A.vkfilter', 'a2'], ['Mine.vkfilter', 'x']]) }))
      .toEqual([{ kind: 'record', file: 'A.vkfilter', digest: 'a2' }]);
  });

  it('leaves a template another platform ships to the catalog pass', () => {
    expect(plan({
      shippedAnywhere: new Set(['A.vkfilter', 'Old.vkfilter']),
      installed: new Map([['A.vkfilter', 'a2'], ['Old.vkfilter', 'o1']]),
    })).toEqual([{ kind: 'record', file: 'A.vkfilter', digest: 'a2' }]);
  });

  it('forgets a ledger entry for a template that is gone for good', () => {
    expect(plan({
      installed: new Map([['A.vkfilter', 'a2']]),
      ledger: { 'A.vkfilter': { digest: 'a2', appVersion: '2.1.0' }, 'Old.vkfilter': { digest: 'o1', appVersion: '2.0.0' } },
    })).toEqual([{ kind: 'forget', file: 'Old.vkfilter' }]);
  });

  it('maps an app version to the release tag it was built from', () => {
    const releases = { '0.12': { x: 'y' }, '2.0.0': { x: 'z' } };
    expect(releaseForVersion('0.12.0', releases)).toEqual({ x: 'y' });
    expect(releaseForVersion('2.0.0-nightly.1', releases)).toEqual({ x: 'z' });
    expect(releaseForVersion(undefined, releases)).toBeUndefined();
  });
});
