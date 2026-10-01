import { describe, expect, it } from 'vitest';
import {
  layoutChains,
  readableFrom,
  resolveReference,
  sideChainLetter,
  sideChainOutput,
  stepTag,
  type GraphStep,
} from './chainGraph';

const step = (id: string, order: number, over: Partial<GraphStep> = {}): GraphStep => ({
  id, order, enabled: true, filterType: 'custom', code: 'clip = clip', preset: id, ...over,
});
const load = (id: string, order: number, over: Partial<GraphStep> = {}): GraphStep =>
  step(id, order, { filterType: 'videoSource', code: '', sourcePath: `D:/${id}.mkv`, ...over });

/**
 * Side chain A (dvd: crop, fps), side chain B (bd: grade), and the main chain
 * (ivtc, upscale, fix). Orders interleave on purpose: a chain is its own list
 * whatever numbers its steps were given.
 */
function chains(over: Record<string, Partial<GraphStep>> = {}) {
  const steps = [
    load('dvd', 0),
    step('crop', 1, { chain: 'dvd' }),
    step('ivtc', 2),
    step('fps', 3, { chain: 'dvd' }),
    load('bd', 4),
    step('grade', 5, { chain: 'bd' }),
    step('upscale', 6, { filterType: 'aiModel', code: '', modelPath: 'C:/m.engine' }),
    step('fix', 7),
  ];
  return steps.map(s => ({ ...s, ...(over[s.id] ?? {}) }));
}
const find = (steps: GraphStep[], id: string) => steps.find(s => s.id === id)!;

describe('laying out the chains', () => {
  it('splits the list into the main chain and side chains by Load Video', () => {
    const { main, side, orphans } = layoutChains(chains());
    expect(main.steps.map(s => s.id)).toEqual(['ivtc', 'upscale', 'fix']);
    expect(side.map(c => [c.id, c.steps.map(s => s.id)])).toEqual([['dvd', ['crop', 'fps']], ['bd', ['grade']]]);
    expect(orphans).toEqual([]);
  });

  it('keeps steps whose Load Video is gone out of every chain', () => {
    const steps = chains().filter(s => s.id !== 'bd');
    const { main, orphans } = layoutChains(steps);
    expect(orphans.map(s => s.id)).toEqual(['grade']);
    expect(main.steps.map(s => s.id)).not.toContain('grade');
  });

  it('hands on the last enabled step that produces a picture, or the video itself', () => {
    const { side } = layoutChains(chains({ fps: { enabled: false } }));
    expect(sideChainOutput(side[0])?.id).toBe('crop');
    const bare = layoutChains(chains({ grade: { code: '  ' } })).side[1];
    expect(sideChainOutput(bare)?.id).toBe('bd');
  });

  it('tags steps the way the rail prints them', () => {
    const steps = chains();
    expect(['ivtc', 'fix', 'dvd', 'fps', 'grade'].map(id => stepTag(steps, id))).toEqual(['1', '3', 'A', 'A2', 'B1']);
    expect(sideChainLetter(26)).toBe('AA');
  });
});

describe('what a named input can read', () => {
  const steps = chains();
  const resolve = (reader: string, value: string, s = steps) => resolveReference(s, find(s, reader), value);

  it('reads a whole side chain from the main chain', () => {
    expect(resolve('fix', 'dvd')).toMatchObject({ state: 'chain' });
  });

  it('reads an earlier step only within its own chain', () => {
    expect(resolve('fix', 'ivtc')).toMatchObject({ state: 'ready' });
    expect(resolve('fps', 'crop')).toMatchObject({ state: 'ready' });
    expect(resolve('fix', 'crop')).toMatchObject({ state: 'otherChain' });
    expect(resolve('grade', 'ivtc')).toMatchObject({ state: 'otherChain' });
  });

  it('lets a side chain read only one that starts above it, so nothing loops', () => {
    expect(resolve('grade', 'dvd')).toMatchObject({ state: 'chain' });
    expect(resolve('fps', 'bd')).toMatchObject({ state: 'chainLoop' });
    expect(resolve('fps', 'dvd')).toMatchObject({ state: 'chainLoop' });
  });

  it('says a side chain is off when its Load Video is off or empty', () => {
    expect(resolve('fix', 'dvd', chains({ dvd: { enabled: false } }))).toMatchObject({ state: 'chainOff' });
    expect(resolve('fix', 'dvd', chains({ dvd: { sourcePath: '' } }))).toMatchObject({ state: 'chainOff' });
  });

  it('keeps the old answers for the main chain', () => {
    expect(resolve('fix', '')).toEqual({ state: 'source' });
    expect(resolve('fix', 'gone')).toEqual({ state: 'missing' });
    expect(resolve('fix', 'fix')).toEqual({ state: 'self' });
    expect(resolve('upscale', 'fix')).toMatchObject({ state: 'below' });
    expect(resolve('fix', 'ivtc', chains({ ivtc: { enabled: false } }))).toMatchObject({ state: 'disabled' });
  });

  it('offers exactly what resolves', () => {
    const fromFix = readableFrom(steps, find(steps, 'fix'));
    expect(fromFix.steps.map(s => s.id)).toEqual(['ivtc', 'upscale']);
    expect(fromFix.chains.map(c => c.id)).toEqual(['dvd', 'bd']);
    const fromGrade = readableFrom(steps, find(steps, 'grade'));
    expect(fromGrade.steps).toEqual([]);
    expect(fromGrade.chains.map(c => c.id)).toEqual(['dvd']);
  });
});
