// Importing a workflow gives every filter a fresh id, which is the one moment
// a stored reference to a step can be broken by nobody doing anything wrong.
// These pin that it is carried across, and that nothing else is.

import { describe, it, expect } from 'vitest';
import { remapStepReferences } from './stepReferences';
import type { Filter } from '../electron.d';

const filter = (id: string, parameters?: Filter['parameters']): Filter => ({
  id,
  enabled: true,
  filterType: 'custom',
  preset: 'Wavelet Color Fix from Step',
  code: 'reference = {{stage:source_id}}',
  order: 0,
  parameters,
});

const moved = new Map([['old-1', 'new-1'], ['old-2', 'new-2']]);

describe('carrying a reference across new ids', () => {
  it('repoints a stored id at the same step under its new name', () => {
    const [step] = remapStepReferences([filter('new-9', { source_id: 'old-1' })], moved);
    expect(step.parameters?.source_id).toBe('new-1');
  });

  it('leaves a value that was never one of the ids alone', () => {
    // A path, a look-up table's file name, a number: none of them are ids, and
    // the rule that says so is that they are not ids the same file handed out.
    const [step] = remapStepReferences(
      [filter('new-9', { source_id: 'old-2', lut_path: 'C:/looks/old-1.cube', size: 33 })],
      moved,
    );
    expect(step.parameters).toEqual({ source_id: 'new-2', lut_path: 'C:/looks/old-1.cube', size: 33 });
  });

  it('leaves an id the file never contained, so it reads as gone rather than as something else', () => {
    const [step] = remapStepReferences([filter('new-9', { source_id: 'from-another-workflow' })], moved);
    expect(step.parameters?.source_id).toBe('from-another-workflow');
  });

  it('changes nothing at all when no ids moved', () => {
    const before = [filter('a', { source_id: 'old-1' }), filter('b')];
    expect(remapStepReferences(before, new Map())).toBe(before);
  });

  it('leaves untouched filters as the same objects', () => {
    const untouched = filter('b', { size: 33 });
    const [, same] = remapStepReferences([filter('a', { source_id: 'old-1' }), untouched], moved);
    expect(same).toBe(untouched);
  });
});
