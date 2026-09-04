// src/components/ColorGradeDock.tsx — the grading palette, docked under the
// preview. Resolve's shape: the picture stays above, the balls sit across the
// full width beneath it, and the chain never leaves the screen.
//
// The dock measures itself rather than reading the window, because what it
// actually has is the preview column — and while a grade is open App.tsx folds
// the settings column away, so that column is nearly the whole window. Width is
// then spent in a fixed order: the primaries never move, the scope panel gives
// up size first, and the tone grid drops columns rather than letting its
// sliders be crushed. That crushing is what a 16:9 window used to do — seven
// tone controls behind a horizontal scrollbar in a 140px column.
//
// Height follows the same rule in reverse: the dock asks for the height its
// chosen layout needs, so a one-column tone list gets the rows to show all
// seven at once instead of scrolling two of them out of sight.

import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { RotateCcw, Save, Gauge } from 'lucide-react';
import { Trackball, readoutColumns, trackballColumnWidth } from './Trackball';
import { Scope, SCOPE_LABELS, type ScopeKind } from './GradeScopes';
import {
  BALL_SPECS,
  SCALAR_SPECS,
  GRADE_NEUTRAL,
  type BallName,
  type BallValues,
  type GradeValues,
  type ScalarSpec,
} from '../utils/colorGrade';

export const GRADE_DOCK_HEIGHT = 230;
export const GRADE_DOCK_COMPACT_HEIGHT = 190;
/** A one-column tone list is seven rows tall; a two-column one is four, so
    the one-column layout needs the extra rows back. */
export const GRADE_DOCK_COMPACT_TALL = 206;
/** Below this window height the balls shrink rather than eat the viewer. */
export const GRADE_COMPACT_BELOW = 960;

interface ColorGradeDockProps {
  values: GradeValues;
  /** A 240px-wide RGB sample of the ungraded frame, for the scopes. */
  scopeSample: Float32Array | null;
  stepLabel: string;
  compact: boolean;
  /** True when the scope column beside the viewer is showing, so the dock has
      no scope of its own and the tone grid takes that width instead. */
  scopesInColumn: boolean;
  disabled?: boolean;
  dockScope: ScopeKind;
  onDockScopeChange: (kind: ScopeKind) => void;
  onChange: (values: GradeValues) => void;
  onCommit: () => void;
  onApply: (values: GradeValues) => void;
  onSaveTemplate?: () => void;
}

const DOCK_SCOPES: ScopeKind[] = ['parade', 'waveform', 'vectorscope', 'histogram'];

/** Gap between balls, and the primaries block's own horizontal padding. */
const BALL_GAP = 14;
const BLOCK_PADDING = 24;
/** A tone slider is 64px of label, 46px of number and its gaps; under about
    this much the bar between them stops being a bar. */
const TONE_COLUMN_MIN = 180;

/* The dock's heights are constants rather than measurements, because App.tsx
   has to know one before the dock is laid out. dockContentNeeded() is what
   keeps them honest: a test walks every layout the solver can pick and fails
   if the constant above it is short. Change a ball size or a readout row and
   that test tells you which constant has to move. */
const DOCK_HEADER = 28;
/** Section label, its gap, and the block's own py-2. */
const BLOCK_CHROME = 35;
/** Master bar, label, hint, and the gaps stacking them under the disc. */
const BALL_CHROME = 42;
const READOUT_ROW = 11;
const READOUT_ROW_GAP = 2;
const TONE_ROW = 16;

/** The height this layout's tallest block actually needs. */
export function dockContentNeeded(ballSize: number, toneColumns: number): number {
  const readoutRows = Math.ceil(4 / readoutColumns(ballSize));
  const primaries = ballSize + BALL_CHROME
    + readoutRows * READOUT_ROW + (readoutRows - 1) * READOUT_ROW_GAP;
  const toneRows = Math.ceil(SCALAR_SPECS.length / toneColumns);
  const toneGap = toneColumns === 1 ? 4 : 6;
  const tone = toneRows * TONE_ROW + (toneRows - 1) * toneGap;
  return DOCK_HEADER + BLOCK_CHROME + Math.max(primaries, tone);
}
/** Narrower than this a scope is a smear, so it leaves rather than shrink. */
const SCOPE_MIN = 160;

export interface DockLayout {
  ballSize: number;
  scopeWidth: number;
  toneColumns: number;
  height: number;
}

/** Solve the dock's blocks for the width it actually has. */
export function solveDockLayout(width: number, compact: boolean, scopesInColumn = false): DockLayout {
  // An unmeasured dock (width 0) resolves to the tightest layout, which is
  // also the tallest; useLayoutEffect measures before paint, so that one
  // never reaches the screen.
  const ballSize = compact
    ? (width < 820 ? 48 : 56)
    : (width < 1100 ? 68 : 84);
  const primaries = trackballColumnWidth(ballSize) * 4 + BALL_GAP * 3 + BLOCK_PADDING;
  const forTools = Math.max(0, width - primaries - 2);

  const wanted = forTools >= 1060 ? 380 : forTools >= 720 ? 360 : forTools >= 440 ? 260 : 200;
  // The scope is the block that yields, all the way to leaving: the tone grid
  // keeping one readable column outranks it. It also leaves outright when the
  // column beside the viewer has the scopes, which is the arrangement with the
  // height to show four of them at once.
  const room = forTools - TONE_COLUMN_MIN;
  const scopeWidth = scopesInColumn || room < SCOPE_MIN ? 0 : Math.min(wanted, room);
  const forTone = forTools - scopeWidth;
  const toneColumns = forTone >= 660 ? 3 : forTone >= 360 ? 2 : 1;

  const height = compact
    ? (toneColumns === 1 ? GRADE_DOCK_COMPACT_TALL : GRADE_DOCK_COMPACT_HEIGHT)
    : GRADE_DOCK_HEIGHT;

  return { ballSize, scopeWidth, toneColumns, height };
}

const formatScalar = (spec: ScalarSpec, value: number) => {
  const text = value.toFixed(spec.precision);
  const signed = value > 0 && (spec.name === 'temperature' || spec.name === 'tint' || spec.name === 'hue' || spec.name === 'brightness')
    ? `+${text}`
    : text;
  return spec.suffix ? `${signed}${spec.suffix}` : signed;
};

/** A tone control: label, bar, and a value you can scrub. */
const ToneSlider = memo<{
  spec: ScalarSpec;
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
  onCommit: () => void;
  onReset: () => void;
}>(({ spec, value, disabled, onChange, onCommit, onReset }) => {
  const fraction = (value - spec.min) / (spec.max - spec.min);
  const neutral = (GRADE_NEUTRAL[spec.name] as number - spec.min) / (spec.max - spec.min);

  const begin = (event: React.MouseEvent) => {
    if (disabled) return;
    event.preventDefault();
    const startX = event.clientX;
    const origin = value;
    const span = spec.max - spec.min;

    const onMove = (move: MouseEvent) => {
      const scale = move.shiftKey ? 0.1 : 1;
      const next = origin + ((move.clientX - startX) / 200) * span * scale;
      const stepped = Math.round(next / spec.step) * spec.step;
      onChange(Math.min(spec.max, Math.max(spec.min, stepped)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      onCommit();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={spec.label}
      aria-valuenow={Number(value.toFixed(spec.precision))}
      aria-valuemin={spec.min}
      aria-valuemax={spec.max}
      onMouseDown={begin}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (disabled) return;
        const step = spec.step * (event.shiftKey ? 1 : 10);
        if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
          event.preventDefault();
          onChange(Math.max(spec.min, value - step));
          onCommit();
        } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
          event.preventDefault();
          onChange(Math.min(spec.max, value + step));
          onCommit();
        }
      }}
      title={`${spec.label} — drag to change, double-click to reset`}
      className={`grid grid-cols-[64px_1fr_46px] items-center gap-2 rounded-sm
        focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-500
        ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-ew-resize'}`}
    >
      <span className="text-[10.5px] text-ink-400 truncate">{spec.label}</span>
      <span className="h-[3px] rounded-sm bg-ink-800 relative block">
        <span aria-hidden="true" className="absolute -top-0.5 w-px h-[7px] bg-ink-700" style={{ left: `${neutral * 100}%` }} />
        <span
          aria-hidden="true"
          className="absolute -top-[3px] w-[9px] h-[9px] rounded-full bg-accent-500 border border-ink-950"
          style={{ left: `calc(${Math.min(1, Math.max(0, fraction)) * 100}% - 4.5px)` }}
        />
      </span>
      <span className="font-mono text-[10px] tabular-nums text-ink-300 text-right">
        {formatScalar(spec, value)}
      </span>
    </div>
  );
});

export const ColorGradeDock = memo<ColorGradeDockProps>(({
  values,
  scopeSample,
  stepLabel,
  compact,
  scopesInColumn,
  disabled = false,
  dockScope,
  onDockScopeChange,
  onChange,
  onCommit,
  onApply,
  onSaveTemplate,
}: ColorGradeDockProps) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  // Measured before paint, so the tightest-layout fallback above never
  // reaches the screen as a flash of shrunken balls.
  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const update = () => setWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const setBall = useCallback((name: BallName, ball: BallValues) => {
    onChange({ ...values, [name]: ball });
  }, [onChange, values]);

  const setScalar = useCallback((name: ScalarSpec['name'], value: number) => {
    onChange({ ...values, [name]: value });
  }, [onChange, values]);

  const { ballSize, scopeWidth, toneColumns, height } = solveDockLayout(width, compact, scopesInColumn);

  return (
    <div
      ref={rootRef}
      className="flex-shrink-0 flex flex-col bg-ink-900 border-t border-ink-700"
      style={{ height }}
    >
      <div className="h-7 flex-shrink-0 flex items-stretch gap-2.5 pr-2 bg-ink-850 border-b border-ink-800">
        <span className="w-[3px] bg-accent-500 flex-shrink-0" aria-hidden="true" />
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <span className="font-display text-[12px] font-semibold uppercase tracking-[0.14em] text-ink-100 whitespace-nowrap">
            Color wheels
          </span>
          <span className="text-[10.5px] text-ink-500 truncate">{stepLabel}</span>
        </div>
        <div className="flex items-center gap-1.5 self-center flex-shrink-0">
          <button
            type="button"
            onClick={() => onApply(GRADE_NEUTRAL)}
            disabled={disabled}
            title="Reset every control on this grade"
            className="h-[21px] px-2 rounded inline-flex items-center gap-1.5 text-[10.5px] font-medium bg-ink-850 border border-ink-750 text-ink-400 hover:text-ink-200 hover:border-ink-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
          >
            <RotateCcw className="w-3 h-3" />
            Reset all
          </button>
          {onSaveTemplate && (
            <button
              type="button"
              onClick={onSaveTemplate}
              disabled={disabled}
              title="Save this grade as a filter template"
              className="h-[21px] px-2 rounded inline-flex items-center gap-1.5 text-[10.5px] font-medium bg-ink-850 border border-ink-750 text-ink-400 hover:text-ink-200 hover:border-ink-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
            >
              <Save className="w-3 h-3" />
              Save as template
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Primaries */}
        <div className="flex-shrink-0 flex flex-col gap-1.5 px-3 py-2 border-r border-ink-850">
          {/* One line, clipped: wrapped to two, it stole a row from the balls. */}
          <span className="font-display text-[9px] font-semibold uppercase tracking-[0.13em] text-ink-500 flex items-center gap-1.5 min-w-0 whitespace-nowrap overflow-hidden">
            Primaries
            <span className="normal-case tracking-normal text-ink-600 font-sans font-normal truncate">
              double-click a ball to reset
            </span>
          </span>
          <div className="flex" style={{ gap: BALL_GAP }}>
            {BALL_SPECS.map(({ name, label, hint }) => (
              <Trackball
                key={name}
                name={name}
                label={label}
                hint={hint}
                value={values[name]}
                size={ballSize}
                disabled={disabled}
                onChange={(ball) => setBall(name, ball)}
                onCommit={onCommit}
              />
            ))}
          </div>
        </div>

        {/* Tone — the column that used to be crushed. It takes what is left
            after the primaries and the scope, and picks a column count that
            shows all seven controls without scrolling either way. */}
        <div className="flex-1 min-w-0 flex flex-col gap-1.5 px-3 py-2 border-r border-ink-850 overflow-y-auto">
          <span className="font-display text-[9px] font-semibold uppercase tracking-[0.13em] text-ink-500">Tone</span>
          <div
            className={`grid gap-x-5 content-start ${toneColumns === 1 ? 'gap-y-1' : 'gap-y-1.5'}`}
            style={{ gridTemplateColumns: `repeat(${toneColumns}, minmax(0, 1fr))` }}
          >
            {SCALAR_SPECS.map(spec => (
              <ToneSlider
                key={spec.name}
                spec={spec}
                value={values[spec.name]}
                disabled={disabled}
                onChange={(value) => setScalar(spec.name, value)}
                onCommit={onCommit}
                onReset={() => onApply({ ...values, [spec.name]: GRADE_NEUTRAL[spec.name] })}
              />
            ))}
          </div>
        </div>

        {/* One scope, at the end of the dock — Resolve's position for them.
            One and not four: every scope grades the whole sample per repaint,
            so a 2x2 grid would cost four times that on every frame of a
            trackball drag. The selector stays in view instead. */}
        {scopeWidth > 0 && (
        <div className="flex-shrink-0 flex flex-col" style={{ width: scopeWidth }}>
          <div className="h-6 flex-shrink-0 flex items-center gap-2 px-2 border-b border-ink-850">
            <Gauge className="w-3 h-3 text-ink-500 flex-shrink-0" />
            <div className="flex ml-auto rounded border border-ink-750 overflow-hidden">
              {DOCK_SCOPES.map(kind => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => onDockScopeChange(kind)}
                  aria-pressed={dockScope === kind}
                  title={SCOPE_LABELS[kind]}
                  className={`px-1.5 h-[17px] text-[9px] border-r border-ink-750 last:border-r-0 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-500 ${
                    dockScope === kind ? 'bg-accent-500/16 text-accent-300' : 'text-ink-500 hover:text-ink-300'
                  }`}
                >
                  {scopeWidth >= 300 ? SCOPE_LABELS[kind] : SCOPE_LABELS[kind].slice(0, 6)}
                </button>
              ))}
            </div>
          </div>
          <Scope kind={dockScope} sample={scopeSample} values={values} className="flex-1" />
        </div>
        )}
      </div>
    </div>
  );
});
