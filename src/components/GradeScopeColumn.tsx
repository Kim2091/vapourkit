// src/components/GradeScopeColumn.tsx — the scopes, beside the viewer.
//
// This is the panel the dock's old `scopesElsewhere` prop was named for and
// which never got written. It belongs here rather than in the dock for one
// measured reason: a scope needs height, and the dock has none to give. The
// dock is 148-202px tall, so a 2x2 inside it would be ~70px a cell; this
// column is as tall as the picture — 352px in a 1200x675 window, 1063px at
// 2560x1440 — which is 176px a cell at the worst size.
//
// It costs nothing to put it here. A 16:9 picture in a wide, short pane is
// bound by height, not width: at every 16:9 window size the picture already
// has more width than it can use, so 380px spent on this column leaves the
// picture exactly the size it was.

import { memo, useLayoutEffect, useRef, useState } from 'react';
import { Gauge } from 'lucide-react';
import { Scope, type ScopeKind } from './GradeScopes';
import type { GradeValues } from '../utils/colorGrade';

/** Most useful first, because a short column only shows the first two.
 *  Parade is what the four trackballs act on — three channels, so channel
 *  balance is read straight off it. The vectorscope is the one thing parade
 *  cannot show: saturation and hue, against the skin line. Waveform is luma
 *  alone, which parade already contains three views of, and the histogram is
 *  the same distribution again without the position in frame. */
const SCOPE_ORDER: ScopeKind[] = ['parade', 'vectorscope', 'waveform', 'histogram'];

/** Under this the cells stop being readable and the column shows two. */
const FOUR_CELL_MIN_HEIGHT = 320;
/** Two cells side by side need the width for it; below, they stack. */
const TWO_COLUMN_MIN_WIDTH = 300;

/** The two widths worth giving the column; below the smaller it stays away. */
const COLUMN_WIDE = 380;
const COLUMN_NARROW = 300;

/** Dragged by hand the column can go narrower than the automatic rule would
    ever offer — a single stacked scope is still worth having — but not so
    narrow it is a stripe. */
export const SCOPE_COLUMN_MIN = 200;
/** What the picture keeps no matter how far the handle is dragged. */
export const PICTURE_MIN_WIDTH = 280;

/**
 * A width the user dragged to, held to what the pane can actually give. This
 * outranks solveScopeColumnWidth: having asked for a width, you get it, right
 * up to the point where the picture would have nothing left. Returns 0 when
 * the pane cannot seat both, which is the same answer as never having asked.
 */
export function clampScopeColumnWidth(requested: number, paneWidth: number): number {
  const room = paneWidth - PICTURE_MIN_WIDTH;
  if (room < SCOPE_COLUMN_MIN) return 0;
  return Math.min(Math.max(requested, SCOPE_COLUMN_MIN), room);
}

/**
 * How much width the column may have, given the pane it sits in and the
 * picture beside it. The rule is the whole argument for putting the scopes
 * here: an object-contain picture in a pane taller-constrained than it is
 * wide leaves width unused, and only that unused width is on offer. Returns
 * 0 whenever the picture would have to give anything up — a tall window, a
 * portrait source, a pane narrowed by the settings column coming back.
 */
export function solveScopeColumnWidth(
  paneWidth: number,
  pictureHeight: number,
  frameAspect: number,
): number {
  if (!(pictureHeight > 0) || !(frameAspect > 0) || !Number.isFinite(frameAspect)) return 0;
  const spare = paneWidth - pictureHeight * frameAspect;
  return spare >= COLUMN_WIDE ? COLUMN_WIDE : spare >= COLUMN_NARROW ? COLUMN_NARROW : 0;
}

export interface ScopeColumnLayout {
  /** How many scopes to show, in SCOPE_ORDER. */
  cells: number;
  /** Grid columns; 2 for a 2x2, 1 for a stack. */
  columns: number;
  /** Repaint gate handed to each scope, in ms. */
  minIntervalMs: number;
}

/** What fits, and what it may cost to keep repainting. */
export function solveScopeColumn(width: number, height: number): ScopeColumnLayout {
  const columns = width >= TWO_COLUMN_MIN_WIDTH ? 2 : 1;
  const cells = height >= FOUR_CELL_MIN_HEIGHT ? 4 : 2;
  // Measured: parade 7.3ms a repaint, all four 13.5ms, against a 16.7ms frame.
  // Four of them at frame rate would miss every frame of a trackball drag, so
  // they are held to roughly 15Hz; two to 25Hz. The picture is shaded on the
  // GPU and is not affected either way.
  const minIntervalMs = cells >= 4 ? 66 : 40;
  return { cells, columns, minIntervalMs };
}

interface GradeScopeColumnProps {
  sample: Float32Array | null;
  values: GradeValues;
  width: number;
}

export const GradeScopeColumn = memo<GradeScopeColumnProps>(({
  sample, values, width,
}: GradeScopeColumnProps) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const update = () => setHeight(element.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { cells, columns, minIntervalMs } = solveScopeColumn(width, height);

  return (
    <div
      ref={rootRef}
      style={{ width }}
      className="flex-shrink-0 flex flex-col min-h-0 border-l border-ink-800 bg-ink-900"
    >
      <div className="h-7 flex-shrink-0 flex items-center gap-2 px-2.5 bg-ink-850 border-b border-ink-800">
        <Gauge className="w-3 h-3 text-ink-500 flex-shrink-0" aria-hidden="true" />
        <span className="font-display text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-300">
          Scopes
        </span>
        <span className="ml-auto text-[9.5px] text-ink-600">after this grade</span>
      </div>
      <div
        className="flex-1 min-h-0 grid gap-px bg-ink-800"
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${Math.ceil(cells / columns)}, minmax(0, 1fr))`,
        }}
      >
        {SCOPE_ORDER.slice(0, cells).map(kind => (
          <Scope
            key={kind}
            kind={kind}
            sample={sample}
            values={values}
            minIntervalMs={minIntervalMs}
            className="min-w-0 min-h-0"
          />
        ))}
      </div>
    </div>
  );
});
