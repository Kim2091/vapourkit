import { describe, it, expect } from 'vitest';
import { stepFrame, playbackBounds } from './Scrubber';
import type { SegmentSelection } from '../electron.d';

const TOTAL = 43640;

const segment = (over: Partial<SegmentSelection> = {}): SegmentSelection => ({
  enabled: true,
  startFrame: 1000,
  endFrame: 2000,
  ...over,
});

describe('stepFrame', () => {
  describe('with nothing selected', () => {
    const off = segment({ enabled: false });

    it('moves the playhead one frame', () => {
      expect(stepFrame(1, null, off, 500, TOTAL)).toEqual({ seek: 501 });
      expect(stepFrame(-1, null, off, 500, TOTAL)).toEqual({ seek: 499 });
    });

    it('leaves the segment alone', () => {
      expect(stepFrame(1, null, off, 500, TOTAL).segment).toBeUndefined();
    });

    it('starts from zero when nothing has been sought yet', () => {
      expect(stepFrame(1, null, off, null, TOTAL)).toEqual({ seek: 1 });
      expect(stepFrame(-1, null, off, null, TOTAL)).toEqual({ seek: 0 });
    });

    it('stops at both ends of the clip', () => {
      expect(stepFrame(-1, null, off, 0, TOTAL)).toEqual({ seek: 0 });
      expect(stepFrame(1, null, off, TOTAL, TOTAL)).toEqual({ seek: TOTAL });
    });

    it('ignores a handle selection while the segment is off', () => {
      // The handles are not on screen, so the arrows belong to the playhead.
      expect(stepFrame(1, 'in', off, 500, TOTAL)).toEqual({ seek: 501 });
    });
  });

  describe('with the in handle selected', () => {
    it('moves the in point and looks at it', () => {
      const result = stepFrame(1, 'in', segment(), 9999, TOTAL);
      expect(result.segment).toMatchObject({ startFrame: 1001, endFrame: 2000 });
      // The playhead follows, so the boundary you just set is the picture.
      expect(result.seek).toBe(1001);
    });

    it('steps backwards', () => {
      expect(stepFrame(-1, 'in', segment(), null, TOTAL).segment)
        .toMatchObject({ startFrame: 999 });
    });

    it('will not cross the out point', () => {
      const tight = segment({ startFrame: 1999, endFrame: 2000 });
      const result = stepFrame(1, 'in', tight, null, TOTAL);
      expect(result.segment).toMatchObject({ startFrame: 1999 });
    });

    it('stops at the start of the clip', () => {
      const result = stepFrame(-1, 'in', segment({ startFrame: 0 }), null, TOTAL);
      expect(result.segment).toMatchObject({ startFrame: 0 });
    });
  });

  describe('with the out handle selected', () => {
    it('moves the out point and looks at it', () => {
      const result = stepFrame(1, 'out', segment(), 0, TOTAL);
      expect(result.segment).toMatchObject({ startFrame: 1000, endFrame: 2001 });
      expect(result.seek).toBe(2001);
    });

    it('will not cross the in point', () => {
      const tight = segment({ startFrame: 1000, endFrame: 1001 });
      expect(stepFrame(-1, 'out', tight, null, TOTAL).segment)
        .toMatchObject({ endFrame: 1001 });
    });

    it('stops at the end of the clip', () => {
      const result = stepFrame(1, 'out', segment({ endFrame: TOTAL }), null, TOTAL);
      expect(result.segment).toMatchObject({ endFrame: TOTAL });
    });

    it('treats an open-ended segment as ending at the last frame', () => {
      // endFrame -1 means "to the end", so stepping back comes off the end.
      const open = segment({ startFrame: 0, endFrame: -1 });
      expect(stepFrame(-1, 'out', open, null, TOTAL).segment)
        .toMatchObject({ endFrame: TOTAL - 1 });
    });
  });

  it('keeps the rest of the segment untouched', () => {
    const original = segment();
    const result = stepFrame(1, 'in', original, null, TOTAL);
    expect(result.segment!.enabled).toBe(true);
    // The input is not mutated — the caller hands this straight to setState.
    expect(original.startFrame).toBe(1000);
  });
});

describe('playbackBounds', () => {
  it('spans the whole clip with no segment', () => {
    expect(playbackBounds(segment({ enabled: false }), TOTAL))
      .toEqual({ first: 0, last: TOTAL - 1 });
  });

  it('spans the segment when one is set', () => {
    // Home and End are about the thing being worked on, and a segment is it.
    expect(playbackBounds(segment(), TOTAL)).toEqual({ first: 1000, last: 1999 });
  });

  it('treats an open-ended segment as running to the last frame', () => {
    expect(playbackBounds(segment({ startFrame: 50, endFrame: -1 }), TOTAL))
      .toEqual({ first: 50, last: TOTAL - 1 });
  });

  it('never points past the clip, whatever the segment says', () => {
    const silly = segment({ startFrame: TOTAL + 900, endFrame: TOTAL + 5000 });
    const bounds = playbackBounds(silly, TOTAL);
    expect(bounds.first).toBeLessThanOrEqual(TOTAL);
    expect(bounds.last).toBe(TOTAL - 1);
  });

  it('stays at zero for an empty clip', () => {
    expect(playbackBounds(segment({ enabled: false }), 0)).toEqual({ first: 0, last: 0 });
  });
});

describe('coarse stepping', () => {
  // Shift-arrow steps a second, which the component passes as the rounded fps.
  const SECOND = 30;

  it('moves the playhead a second at a time', () => {
    const off = segment({ enabled: false });
    expect(stepFrame(SECOND, null, off, 5000, TOTAL)).toEqual({ seek: 5030 });
    expect(stepFrame(-SECOND, null, off, 5000, TOTAL)).toEqual({ seek: 4970 });
  });

  it('still clamps at the ends', () => {
    const off = segment({ enabled: false });
    expect(stepFrame(-SECOND, null, off, 10, TOTAL)).toEqual({ seek: 0 });
    expect(stepFrame(SECOND, null, off, TOTAL - 5, TOTAL)).toEqual({ seek: TOTAL });
  });

  it('will not shove a handle past its neighbour', () => {
    const tight = segment({ startFrame: 1000, endFrame: 1010 });
    expect(stepFrame(SECOND, 'in', tight, null, TOTAL).segment)
      .toMatchObject({ startFrame: 1009 });
    expect(stepFrame(-SECOND, 'out', tight, null, TOTAL).segment)
      .toMatchObject({ endFrame: 1001 });
  });
});
