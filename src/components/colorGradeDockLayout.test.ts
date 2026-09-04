// The dock's width rule, pinned. The bug this guards against is the one a
// 16:9 window used to hit: the tone column is the only flexible block, so a
// dock too narrow for primaries + scope drove it to ~140px and put all seven
// tone controls behind a horizontal scrollbar.

import { describe, it, expect } from 'vitest';
import {
  solveDockLayout, dockContentNeeded,
  GRADE_DOCK_COMPACT_TALL, GRADE_DOCK_COMPACT_HEIGHT,
} from './ColorGradeDock';
import { trackballColumnWidth } from './Trackball';

/** Blocks the dock lays out beside the tone column. */
const BALL_GAP = 14;
const BLOCK_PADDING = 24;
const primariesWidth = (ballSize: number, basePx: number) =>
  trackballColumnWidth(ballSize, basePx) * 4 + BALL_GAP * 3 + BLOCK_PADDING;
const toneWidth = (width: number, layout: ReturnType<typeof solveDockLayout>) =>
  width - primariesWidth(layout.ballSize, layout.basePx) - layout.scopeWidth - 2;

/** Chrome between the window edge and the dock: rail, and the folded strip. */
const dockWidth = (windowWidth: number) => windowWidth - 63 - 34;
/** The same, with the settings column revealed over the top of a grade. */
const dockWidthWithSettings = (windowWidth: number) => windowWidth - 63 - 5 - 400;

describe('solveDockLayout', () => {
  it('never crushes the tone column, at any width the app can produce', () => {
    for (let width = 600; width <= 2600; width += 1) {
      for (const compact of [true, false]) {
        const layout = solveDockLayout(width, compact);
        const tone = toneWidth(width, layout);
        // One readable column at minimum, and never a negative box.
        expect(tone / layout.toneColumns).toBeGreaterThanOrEqual(150);
        // A scope either has room to be read or it stands down; it is never
        // a 40px smear taken out of the tone column.
        expect(layout.scopeWidth === 0 || layout.scopeWidth >= 160).toBe(true);
      }
    }
  });

  it('fits every block inside the dock from 900px of window upwards', () => {
    for (let window = 900; window <= 2600; window += 1) {
      const width = dockWidth(window);
      const layout = solveDockLayout(width, true);
      const used = primariesWidth(layout.ballSize, layout.basePx) + layout.scopeWidth + 2;
      expect(used).toBeLessThan(width);
      // Every window the app can actually be sized to keeps its scope.
      expect(layout.scopeWidth).toBeGreaterThan(0);
    }
  });

  it('gives a 16:9 window two tone columns once the settings column folds', () => {
    // 1200x675 and 1600x900 are both short enough to be compact.
    expect(solveDockLayout(dockWidth(1200), true).toneColumns).toBeGreaterThanOrEqual(2);
    expect(solveDockLayout(dockWidth(1600), true).toneColumns).toBeGreaterThanOrEqual(2);
    expect(solveDockLayout(dockWidth(1920), true).toneColumns).toBeGreaterThanOrEqual(2);
  });

  it('falls back to one taller column when the settings column is revealed', () => {
    const layout = solveDockLayout(dockWidthWithSettings(1200), true);
    expect(layout.toneColumns).toBe(1);
    expect(layout.height).toBe(GRADE_DOCK_COMPACT_TALL);
  });

  it('keeps the short dock height whenever the tone grid has columns to spare', () => {
    expect(solveDockLayout(dockWidth(1200), true).height).toBe(GRADE_DOCK_COMPACT_HEIGHT);
  });

  it('shrinks the balls before it shrinks anything else', () => {
    expect(solveDockLayout(dockWidthWithSettings(1200), true).ballSize)
      .toBeLessThan(solveDockLayout(dockWidth(1600), true).ballSize);
    // A tall window keeps full-size balls once there is width for them.
    expect(solveDockLayout(dockWidth(2560), false).ballSize).toBe(84);
  });

  it('sizes the panel type up with the room, never below the floor', () => {
    const small = solveDockLayout(dockWidthWithSettings(1200), true).basePx;
    const large = solveDockLayout(dockWidth(2560), false).basePx;
    expect(small).toBeGreaterThanOrEqual(12);
    expect(large).toBeGreaterThan(small);
    // Nothing the solver can pick goes back to the 9px the panel started at.
    for (let width = 600; width <= 2600; width += 1) {
      for (const compact of [true, false]) {
        expect(solveDockLayout(width, compact).basePx).toBeGreaterThanOrEqual(12);
      }
    }
  });
});

describe('scopes in the column beside the viewer', () => {
  it('hands the dock scope width to the tone grid', () => {
    const width = dockWidth(1200);
    const withScope = solveDockLayout(width, true, false);
    const without = solveDockLayout(width, true, true);
    expect(without.scopeWidth).toBe(0);
    expect(toneWidth(width, without)).toBeGreaterThan(toneWidth(width, withScope));
  });

  it('never leaves the dock without a scope while the column is away', () => {
    for (let window = 900; window <= 2600; window += 1) {
      expect(solveDockLayout(dockWidth(window), true, false).scopeWidth).toBeGreaterThan(0);
    }
  });
});

describe('the dock is tall enough for what it chose to show', () => {
  it('never picks a layout that overflows its own height', () => {
    // The readout under a ball wraps to two rows, which is taller than the
    // one row the dock heights were first set for. This is the check that
    // says so out loud instead of clipping the numbers off the bottom.
    for (let width = 600; width <= 2600; width += 1) {
      for (const compact of [true, false]) {
        for (const scopesInColumn of [true, false]) {
          const layout = solveDockLayout(width, compact, scopesInColumn);
          expect(dockContentNeeded(layout.ballSize, layout.toneColumns, layout.basePx))
            .toBeLessThanOrEqual(layout.height);
        }
      }
    }
  });
});
