import { describe, expect, it } from 'vitest';
import { JobSlot } from './jobSlot';

describe('a job slot', () => {
  it('stops the job it replaces, with the reason given', () => {
    const stopped: [string, string][] = [];
    const slot = new JobSlot<string, string>((job, reason) => stopped.push([job, reason]));

    slot.start('a', 'first');
    slot.start('b', 'replaced');

    expect(stopped).toEqual([['a', 'replaced']]);
    expect(slot.current).toBe('b');
  });

  it('stop() empties the slot and reports whether a job was running', () => {
    const stopped: string[] = [];
    const slot = new JobSlot<string>(job => stopped.push(job));

    expect(slot.stop()).toBe(false);
    slot.start('a');
    expect(slot.stop()).toBe(true);
    expect(slot.current).toBeNull();
    expect(stopped).toEqual(['a']);
  });

  it('release() only lets go of the job it names, and never stops it', () => {
    const stopped: string[] = [];
    const slot = new JobSlot<string>(job => stopped.push(job));

    slot.start('a');
    slot.start('b');
    slot.release('a');
    expect(slot.holds('b')).toBe(true);
    slot.release('b');
    expect(slot.current).toBeNull();
    expect(stopped).toEqual(['a']);
  });
});
