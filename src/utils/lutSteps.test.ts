// A Create LUT remembers the colour where it sits and a Load LUT pointed at it
// puts that colour back. Nothing is asked: both ends of the table are the two
// steps' own positions. These pin what that reading says for the chain that
// was reported — a marker, an upscaler, a Load LUT, a grade — and for the
// ways the two steps can be placed wrongly.

import { describe, it, expect } from 'vitest';
import {
  bakeSpan, loadersOf, markerPlace, markersAbove, outputOf, restoreFingerprint, restoreLink, stepNumber,
} from './lutSteps';
import { stepLabels } from '../hooks/useChainPreview';
import type { Filter } from '../electron.d';

let order = 0;
const filter = (over: Partial<Filter>): Filter => ({
  id: `f${++order}`,
  enabled: true,
  filterType: 'custom',
  preset: '',
  code: '',
  order,
  ...over,
});

/** The chain from the report: a marker, then a model, then a restore, then a grade. */
function chain() {
  order = 0;
  const marker = filter({ id: 'marker', preset: 'Create LUT', order: 0 });
  const uplift = filter({ id: 'uplift', preset: 'DLSS Neural Uplift', order: 1 });
  const loader = filter({ id: 'loader', preset: 'Load LUT', parameters: { source_id: 'marker', lut_path: '' }, order: 2 });
  const grade = filter({ id: 'grade', preset: 'Color Grade', order: 3 });
  return { filters: [marker, uplift, loader, grade], marker, uplift, loader, grade };
}

describe('naming a marker by where it sits', () => {
  it('is numbered the way the filter panel numbers it, disabled steps included', () => {
    const { filters, marker, grade } = chain();
    expect(stepNumber(filters, marker.id)).toBe(1);
    expect(stepNumber(filters, grade.id)).toBe(4);
    const withOneOff = filters.map(f => f.id === 'uplift' ? { ...f, enabled: false } : f);
    expect(stepNumber(withOneOff, grade.id)).toBe(4);
    expect(outputOf(withOneOff, grade.id)).toBe(3);
  });

  it('agrees with the preview about which output is which', () => {
    const { filters } = chain();
    const labels = stepLabels(filters);
    for (const step of filters) {
      expect(labels[outputOf(filters, step.id)]).toBe(step.preset);
    }
  });

  it('says what it is placed before, looking past other markers', () => {
    const { filters } = chain();
    expect(markerPlace(filters, 'marker')).toBe('before DLSS Neural Uplift');

    order = 10;
    const twoInARow = [
      filter({ id: 'a', preset: 'Create LUT', order: 0 }),
      filter({ id: 'b', preset: 'Create LUT', order: 1 }),
      filter({ id: 'c', preset: 'CAS Sharpen', order: 2 }),
      filter({ id: 'd', preset: 'Create LUT', order: 3 }),
    ];
    expect(markerPlace(twoInARow, 'a')).toBe('before CAS Sharpen');
    expect(markerPlace(twoInARow, 'b')).toBe('before CAS Sharpen');
    expect(markerPlace(twoInARow, 'd')).toBe('at the end of the chain');
  });
});

describe('a Load LUT pointed at a marker above it', () => {
  it('reads from its own input back to the marker, and has to be measured past the uplift', () => {
    const { filters, loader } = chain();
    const link = restoreLink(filters, loader);
    expect(link.state).toBe('ready');
    if (link.state !== 'ready') return;
    // Output 2 is the uplift's picture — what arrives at the Load LUT.
    // Output 1 is the marker's, which is the untouched source.
    expect(link.from).toBe(2);
    expect(link.to).toBe(1);
    expect(link.number).toBe(1);
    expect(link.place).toBe('before DLSS Neural Uplift');
    expect(link.method.kind).toBe('measure');
    if (link.method.kind === 'measure') expect(link.method.because.label).toBe('DLSS Neural Uplift');
  });

  it('is solved exactly when only modelled steps sit between', () => {
    const { filters, loader } = chain();
    const graded = filters.map(f => f.id === 'uplift'
      ? { ...f, preset: 'Color Grade', editor: { type: 'colorGrade', variables: {} } as unknown as Filter['editor'] }
      : f);
    const link = restoreLink(graded, loader);
    expect(link.state).toBe('ready');
    if (link.state === 'ready') expect(link.method).toEqual({ kind: 'solve', captured: ['Color Grade'] });
  });

  it('has nothing to put back when it sits directly under the marker', () => {
    const { filters, loader } = chain();
    const adjacent = filters.map(f => f.id === 'uplift' ? { ...f, enabled: false } : f);
    const link = restoreLink(adjacent, loader);
    expect(link.state).toBe('ready');
    if (link.state === 'ready') expect(link.method.kind).toBe('nothing');
  });

  it('refuses a marker below it rather than solving the chain forwards', () => {
    const { filters, loader } = chain();
    const swapped = filters.map(f => f.id === 'marker' ? { ...f, order: 5 } : f);
    const link = restoreLink(swapped, loader);
    expect(link.state).toBe('below');
  });

  it('says when the marker is disabled, gone, or never chosen', () => {
    const { filters, loader } = chain();
    expect(restoreLink(filters.map(f => f.id === 'marker' ? { ...f, enabled: false } : f), loader).state).toBe('disabled');
    expect(restoreLink(filters.filter(f => f.id !== 'marker'), loader).state).toBe('missing');
    expect(restoreLink(filters, { ...loader, parameters: {} }).state).toBe('none');
    expect(restoreLink(filters, { ...loader, parameters: { source_id: 'uplift' } }).state).toBe('missing');
  });

  it('is offered only the markers above it', () => {
    const { filters, loader } = chain();
    order = 10;
    const below = filter({ id: 'late', preset: 'Create LUT', order: 4 });
    expect(markersAbove([...filters, below], loader).map(f => f.id)).toEqual(['marker']);
    expect(loadersOf(filters, 'marker').map(f => f.id)).toEqual(['loader']);
    expect(loadersOf(filters, 'late')).toEqual([]);
  });
});

describe('what a restore depended on', () => {
  it('changes when a step between the two moves, and not otherwise', () => {
    const { filters, loader } = chain();
    const link = restoreLink(filters, loader);
    if (link.state !== 'ready') throw new Error('expected a ready link');
    const before = restoreFingerprint(filters, link, 33);

    // The grade sits below the Load LUT, so it is not between the pair.
    const gradeChanged = filters.map(f => f.id === 'grade' ? { ...f, parameters: { contrast: 2 } } : f);
    const link2 = restoreLink(gradeChanged, loader);
    if (link2.state !== 'ready') throw new Error('expected a ready link');
    expect(restoreFingerprint(gradeChanged, link2, 33)).toBe(before);

    const upliftChanged = filters.map(f => f.id === 'uplift' ? { ...f, parameters: { strength: 0.5 } } : f);
    const link3 = restoreLink(upliftChanged, loader);
    if (link3.state !== 'ready') throw new Error('expected a ready link');
    expect(restoreFingerprint(upliftChanged, link3, 33)).not.toBe(before);
    expect(restoreFingerprint(filters, link, 65)).not.toBe(before);
  });
});

describe('what a marker can save', () => {
  it('has nothing to save at the top of the chain, which is where a restore marker goes', () => {
    const { filters, marker } = chain();
    expect(bakeSpan(filters, marker)?.method.kind).toBe('nothing');
  });

  it('bakes the colour work above it, and measures when something unmodelled is in it', () => {
    const { filters, marker } = chain();
    const atTheEnd = filters.map(f => f.id === 'marker' ? { ...f, order: 5 } : f);
    const span = bakeSpan(atTheEnd, marker);
    expect(span?.to).toBe(4);
    expect(span?.method.kind).toBe('measure');
  });

  it('is nothing for a disabled marker', () => {
    const { filters, marker } = chain();
    const off = filters.map(f => f.id === marker.id ? { ...f, enabled: false } : f);
    expect(bakeSpan(off, marker)).toBeNull();
  });
});
