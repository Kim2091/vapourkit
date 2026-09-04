// The claim the scope column rests on: at a 16:9 window it is drawn from
// width the picture could not have used, so putting it there costs nothing.
// If that stops being true the column is supposed to leave, and these are
// the sizes where it must.

import { describe, it, expect } from 'vitest';
import {
  solveScopeColumnWidth, solveScopeColumn, clampScopeColumnWidth,
  SCOPE_COLUMN_MIN, PICTURE_MIN_WIDTH,
} from './GradeScopeColumn';
import { GRADE_DOCK_HEIGHT, GRADE_DOCK_COMPACT_HEIGHT, GRADE_COMPACT_BELOW } from './ColorGradeDock';

/** The same geometry App.tsx feeds it: rail, folded strip, and the chrome
    above and below the picture. */
const paneWidth = (w: number) => w - 63 - 34;
const pictureHeight = (h: number) =>
  h - (45 + 37 + (h < GRADE_COMPACT_BELOW ? GRADE_DOCK_COMPACT_HEIGHT : GRADE_DOCK_HEIGHT) + 41) - 24;

const SIXTEEN_NINE: [number, number][] = [
  [1200, 675], [1366, 768], [1600, 900], [1920, 1080], [2560, 1440],
];

describe('solveScopeColumnWidth', () => {
  it('gives the full column at every 16:9 window, out of spare width', () => {
    for (const [w, h] of SIXTEEN_NINE) {
      const picture = pictureHeight(h);
      const width = solveScopeColumnWidth(paneWidth(w), picture, 16 / 9);
      expect(width).toBe(380);
      // And the picture keeps every pixel it was using.
      expect(paneWidth(w) - width).toBeGreaterThanOrEqual(picture * (16 / 9));
    }
  });

  it('stays away when the picture would have to give something up', () => {
    // A tall window: the picture runs out of width before it runs out of
    // height, so there is nothing spare to take.
    expect(solveScopeColumnWidth(paneWidth(1000), pictureHeight(1400), 16 / 9)).toBe(0);
    // The boundary itself, rather than a window size that would drift the
    // moment an unrelated constant moves: a pixel short of the narrowest
    // column worth showing, and it withdraws instead of shaving the picture.
    const picture = 400;
    const needs = picture * 2.39;
    expect(solveScopeColumnWidth(needs + 299, picture, 2.39)).toBe(0);
    expect(solveScopeColumnWidth(needs + 300, picture, 2.39)).toBe(300);
  });

  it('has more to spare for a narrow frame, not less', () => {
    // Portrait is height-bound too, and wants less width than 16:9 does, so
    // the column is if anything freer there.
    expect(solveScopeColumnWidth(paneWidth(1600), pictureHeight(900), 9 / 16)).toBe(380);
  });

  it('refuses nonsense geometry rather than rendering a broken column', () => {
    expect(solveScopeColumnWidth(2000, 0, 16 / 9)).toBe(0);
    expect(solveScopeColumnWidth(2000, -50, 16 / 9)).toBe(0);
    expect(solveScopeColumnWidth(2000, 400, Number.NaN)).toBe(0);
    expect(solveScopeColumnWidth(2000, 400, 0)).toBe(0);
  });
});

describe('solveScopeColumn', () => {
  it('shows all four scopes at every 16:9 window', () => {
    for (const [, h] of SIXTEEN_NINE) {
      expect(solveScopeColumn(380, pictureHeight(h)).cells).toBe(4);
      expect(solveScopeColumn(380, pictureHeight(h)).columns).toBe(2);
    }
  });

  it('drops to two scopes rather than four unreadable ones', () => {
    const short = solveScopeColumn(380, 240);
    expect(short.cells).toBe(2);
    // Every cell stays at or above the height a scope can be read at.
    expect(240 / (short.cells / short.columns)).toBeGreaterThanOrEqual(120);
  });

  it('paces four scopes slower than two, since four cost more per repaint', () => {
    expect(solveScopeColumn(380, 600).minIntervalMs)
      .toBeGreaterThan(solveScopeColumn(380, 240).minIntervalMs);
  });
});

describe('clampScopeColumnWidth', () => {
  it('honours a width that was asked for, over the automatic rule', () => {
    expect(clampScopeColumnWidth(640, 1503)).toBe(640);
    expect(clampScopeColumnWidth(220, 1503)).toBe(220);
  });

  it('never lets the handle take the picture below its floor', () => {
    // Dragged hard left in a 1103px pane: the picture keeps 280.
    expect(clampScopeColumnWidth(5000, 1103)).toBe(1103 - PICTURE_MIN_WIDTH);
    expect(clampScopeColumnWidth(5000, 1103) + PICTURE_MIN_WIDTH).toBe(1103);
  });

  it('never lets the handle squeeze the scopes into a stripe', () => {
    expect(clampScopeColumnWidth(10, 1103)).toBe(SCOPE_COLUMN_MIN);
    expect(clampScopeColumnWidth(-500, 1103)).toBe(SCOPE_COLUMN_MIN);
  });

  it('gives up entirely when the pane cannot seat both', () => {
    expect(clampScopeColumnWidth(380, SCOPE_COLUMN_MIN + PICTURE_MIN_WIDTH - 1)).toBe(0);
    expect(clampScopeColumnWidth(380, SCOPE_COLUMN_MIN + PICTURE_MIN_WIDTH)).toBe(SCOPE_COLUMN_MIN);
  });
});
