// A step that reads another step's picture has one choice and four ways for
// that choice to go bad afterwards. These pin all five, and pin them against
// the same rules the generator applies — the card exists to say what the
// script would say, before anyone presses render.

import { describe, it, expect } from 'vitest';
import { producesPicture, stageLink, stagesAbove } from './stageSource';
import type { Filter } from '../electron.d';
import { encodeReferenceVideo } from '../../electron/referenceVideo';

let order = 0;
const filter = (over: Partial<Filter>): Filter => ({
  id: `f${++order}`,
  enabled: true,
  filterType: 'custom',
  preset: '',
  code: 'clip = core.std.BoxBlur(clip)',
  order,
  ...over,
});

/** Sharpen, an upscaler, then a colour fix reading from somewhere above. */
function chain(sourceId: string) {
  order = 0;
  const sharpen = filter({ id: 'sharpen', preset: 'CAS Sharpen', order: 0 });
  const uplift = filter({
    id: 'uplift', preset: 'AI Model', filterType: 'aiModel', code: '',
    modelPath: 'C:/models/4x-AnimeSharp.engine', order: 1,
  });
  const fix = filter({
    id: 'fix', preset: 'Wavelet Color Fix from Step', order: 2,
    parameters: { source_id: sourceId },
  });
  return { filters: [sharpen, uplift, fix], sharpen, uplift, fix };
}

const link = (sourceId: string, edit: (f: Filter[]) => Filter[] = f => f) => {
  const { filters, fix } = chain(sourceId);
  const edited = edit(filters);
  return stageLink(edited, edited.find(f => f.id === fix.id)!, 'source_id');
};

describe('what a stage reference is pointed at', () => {
  it('means the source when nothing is named', () => {
    expect(link('')).toEqual({ state: 'source' });
  });

  it('names an enabled step above it by the number the panel prints', () => {
    expect(link('sharpen')).toMatchObject({ state: 'ready', tag: '1', label: 'CAS Sharpen' });
  });

  it('labels a model step by its model, the way the rail does', () => {
    expect(link('uplift')).toMatchObject({ state: 'ready', tag: '2', label: '4x-AnimeSharp' });
  });

  it('names a video file outside the chain, with its offset', () => {
    const value = encodeReferenceVideo({ path: 'D:/dvd/ep01.mkv', offset: 5 });
    expect(link(value)).toEqual({ state: 'file', video: { path: 'D:/dvd/ep01.mkv', offset: 5 } });
  });

  it('says the step is gone rather than falling back to the source', () => {
    expect(link('sharpen', f => f.filter(step => step.id !== 'sharpen'))).toEqual({ state: 'missing' });
  });

  it('says the step is turned off', () => {
    const off = link('sharpen', f => f.map(s => s.id === 'sharpen' ? { ...s, enabled: false } : s));
    expect(off).toMatchObject({ state: 'disabled', tag: '1' });
  });

  it('says the step is below, which is the reordering case', () => {
    // The fix dragged above the sharpen it was reading from. Nothing about the
    // stored id changed; what changed is that it now points downhill — and the
    // sharpen is step 2 now, because that is where the person can see it.
    const moved = link('sharpen', f => f.map(s => s.id === 'fix' ? { ...s, order: -1 } : s));
    expect(moved).toMatchObject({ state: 'below', tag: '2' });
  });

  it('says a step with no model chosen produces nothing to read', () => {
    const empty = link('uplift', f => f.map(s => s.id === 'uplift' ? { ...s, modelPath: undefined } : s));
    expect(empty).toMatchObject({ state: 'silent', tag: '2' });
  });

  it('says a custom step with an empty body produces nothing to read', () => {
    const empty = link('sharpen', f => f.map(s => s.id === 'sharpen' ? { ...s, code: '   ' } : s));
    expect(empty).toMatchObject({ state: 'silent', tag: '1' });
  });

  it('refuses a step naming itself', () => {
    expect(link('fix')).toEqual({ state: 'self' });
  });
});

describe('which steps are worth offering', () => {
  it('offers everything enabled above that actually produces a picture', () => {
    const { filters, fix } = chain('');
    expect(stagesAbove(filters, fix).map(step => step.id)).toEqual(['sharpen', 'uplift']);
  });

  it('never offers a step that would then have to be refused', () => {
    const { filters, fix } = chain('');
    const broken = filters.map(step => {
      if (step.id === 'sharpen') return { ...step, enabled: false };
      if (step.id === 'uplift') return { ...step, modelPath: undefined };
      return step;
    });
    expect(stagesAbove(broken, broken.find(f => f.id === fix.id)!)).toEqual([]);
  });

  it('offers nothing below, including the step doing the reading', () => {
    const { filters, sharpen } = chain('');
    expect(stagesAbove(filters, sharpen)).toEqual([]);
  });
});

describe('whether a step puts a picture into the chain', () => {
  it('turns on the model for an AI step and on the body for a custom one', () => {
    order = 0;
    expect(producesPicture(filter({ filterType: 'aiModel', code: '', modelPath: 'm.onnx' }))).toBe(true);
    expect(producesPicture(filter({ filterType: 'aiModel', code: 'clip = clip' }))).toBe(false);
    expect(producesPicture(filter({ code: 'clip = clip' }))).toBe(true);
    expect(producesPicture(filter({ code: '  \n ' }))).toBe(false);
  });
});
