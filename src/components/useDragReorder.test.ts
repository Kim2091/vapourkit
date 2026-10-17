import { describe, expect, it } from 'vitest';
import type { Filter } from '../electron.d';
import { canDropOn, moveStepOnto, moveStepToChainEnd, withChain } from './useDragReorder';

const step = (id: string, order: number, extra: Partial<Filter> = {}): Filter =>
  ({ id, enabled: true, filterType: 'custom', preset: id, code: '', order, ...extra });

const head = step('v', 0, { filterType: 'videoSource' });
const side = step('s', 1, { chain: 'v' });
const a = step('a', 2);
const b = step('b', 3);
const steps = [head, side, a, b];

describe('canDropOn', () => {
  it('lets a step land anywhere, and a Load Video only on another', () => {
    expect(canDropOn(steps, 'a', 'v')).toBe(true);
    expect(canDropOn(steps, 'a', 'b')).toBe(true);
    expect(canDropOn(steps, 'v', 'a')).toBe(false);
    expect(canDropOn(steps, 'v', 'v')).toBe(true);
  });
});

describe('withChain', () => {
  it('drops the chain key for the main chain', () => {
    expect('chain' in withChain(side, undefined)).toBe(false);
    expect(withChain(a, 'v').chain).toBe('v');
  });
});

describe('moveStepOnto', () => {
  it('moves a step to the target and renumbers', () => {
    const result = moveStepOnto(steps, 'b', 'a')!;
    expect(result.steps.map(f => f.id)).toEqual(['v', 's', 'b', 'a']);
    expect(result.steps.map(f => f.order)).toEqual([0, 1, 2, 3]);
    expect(result.reveal).toBeUndefined();
  });

  it('puts a step dropped on a Load Video into its side chain and reveals it', () => {
    const result = moveStepOnto(steps, 'b', 'v')!;
    expect(result.steps.find(f => f.id === 'b')!.chain).toBe('v');
    expect(result.reveal).toBe('v');
  });

  it('takes a side step dropped on a main step out of the side chain', () => {
    const result = moveStepOnto(steps, 's', 'b')!;
    expect('chain' in result.steps.find(f => f.id === 's')!).toBe(false);
  });

  it('does nothing for a drop on itself, a refused drop or an unknown step', () => {
    expect(moveStepOnto(steps, 'a', 'a')).toBeNull();
    expect(moveStepOnto(steps, 'v', 'a')).toBeNull();
    expect(moveStepOnto(steps, null, 'a')).toBeNull();
    expect(moveStepOnto(steps, 'zz', 'a')).toBeNull();
  });
});

describe('moveStepToChainEnd', () => {
  it('moves a step after the side chain\'s last step', () => {
    const moved = moveStepToChainEnd(steps, 'b', 'v')!;
    const b2 = moved.find(f => f.id === 'b')!;
    expect(b2.chain).toBe('v');
    expect(b2.order).toBe(1.5);
  });

  it('refuses a Load Video', () => {
    expect(moveStepToChainEnd(steps, 'v', 'v')).toBeNull();
  });
});
