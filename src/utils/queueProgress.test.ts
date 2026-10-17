import { describe, it, expect } from 'vitest';
import { shouldRecordProgress } from './queueProgress';

describe('shouldRecordProgress', () => {
  const last = { at: 10_000, percentage: 40 };

  it('waits a second between small steps', () => {
    expect(shouldRecordProgress(41, last, 10_500)).toBe(false);
    expect(shouldRecordProgress(41, last, 11_000)).toBe(true);
  });

  it('writes a 5% jump or the finish at once', () => {
    expect(shouldRecordProgress(45, last, 10_100)).toBe(true);
    expect(shouldRecordProgress(100, { at: 10_000, percentage: 99 }, 10_001)).toBe(true);
  });
});
