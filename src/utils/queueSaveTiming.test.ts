import { describe, expect, it } from 'vitest';
import { QUEUE_SAVE_DEBOUNCE_MS, QUEUE_SAVE_MAX_WAIT_MS, queueSaveDelay, queueShape } from './queueSaveTiming';

describe('queueSaveDelay', () => {
  it('debounces an ordinary change', () => {
    expect(queueSaveDelay(false, 1000, 1000)).toBe(QUEUE_SAVE_DEBOUNCE_MS);
  });

  it('saves at once when an item is added, removed, moved or changes status', () => {
    expect(queueSaveDelay(true, 1000, 1000)).toBe(0);
  });

  it('caps the wait when progress keeps changing the queue', () => {
    // A change every second would restart a plain debounce forever.
    let pendingSince = 0;
    let firedAt: number | null = null;
    for (let now = 0; now <= 20000 && firedAt === null; now += 1000) {
      const due = now + queueSaveDelay(false, pendingSince, now);
      if (due < now + 1000) firedAt = due;
    }
    expect(firedAt).not.toBeNull();
    expect(firedAt!).toBeLessThanOrEqual(QUEUE_SAVE_MAX_WAIT_MS);
    pendingSince = firedAt!;
    expect(queueSaveDelay(false, pendingSince, pendingSince)).toBe(QUEUE_SAVE_DEBOUNCE_MS);
  });
});

describe('queueShape', () => {
  it('changes with status and order, not with progress', () => {
    const a = [{ id: '1', status: 'processing' as const }, { id: '2', status: 'pending' as const }];
    expect(queueShape(a)).toBe(queueShape([{ ...a[0] }, { ...a[1] }]));
    expect(queueShape(a)).not.toBe(queueShape([{ ...a[0], status: 'completed' }, a[1]]));
    expect(queueShape(a)).not.toBe(queueShape([a[1], a[0]]));
  });
});
