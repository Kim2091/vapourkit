// src/components/PreviewStepRail.tsx — the filter chain, as selectable steps.
//
// One tab per output the preview session exposes: the source, then each
// enabled filter in order. Number keys select, the way vs-view's output tabs
// do, because that is the shortcut anyone coming from it already has in their
// fingers — 1 is the first tab, and 0 is the tenth.

import { memo, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Layers, AlertTriangle, Ban, ChevronDown, Pin } from 'lucide-react';
import type { ChainPreviewFrame, ChainPreviewStep } from '../hooks/useChainPreview';
import type { CompareMode } from './ColorGradeOverlay';

/**
 * The two view controls, which belong to this bar rather than to the grade.
 *
 * The rail already answers "which picture am I looking at" — it picks the
 * step whose output is on screen. Which side of the open grade you are seeing,
 * and whether the clip marks are drawn over it, are the same question one
 * level down, so they are asked in the same place. They were in the panel's
 * title bar, then briefly in the grading dock; neither is where you look when
 * you are looking at the picture.
 */
export interface ViewerControls {
  compareMode: CompareMode;
  onCompareModeChange: (mode: CompareMode) => void;
  /** True while B is held, so the segment can show which state that is. */
  holdingBefore: boolean;
  showClipping: boolean;
  onShowClippingChange: (show: boolean) => void;
  /** False when no picture is going through the shader that draws the marks. */
  canShowClipping: boolean;
  /**
   * Which step the "before" side shows, when the chain is open to offer a
   * choice. Null pins nothing and compares the frame against itself, which is
   * the ordinary before/after; pinning another step is how you grade one step
   * to match another rather than to look right on its own.
   */
  reference?: ReferenceChoice | null;
}

export interface ReferenceChoice {
  steps: { index: number; label: string }[];
  pinned: number | null;
  onPin: (index: number | null) => void;
}

const COMPARE_MODES: { id: CompareMode; label: string; title: string }[] = [
  { id: 'before', label: 'Before', title: 'The picture entering this grade, in full' },
  { id: 'split', label: 'Split', title: 'Both, divided across the frame — drag the divider to move it' },
  { id: 'after', label: 'After', title: 'The graded picture, in full' },
];

/** The compare group and the clip toggle, drawn once for both rail states. */
const ViewerGroup = memo<{ viewer: ViewerControls }>(({ viewer }) => {
  const [pinMenuOpen, setPinMenuOpen] = useState(false);
  const reference = viewer.reference ?? null;
  const pinnedStep = reference?.steps.find(step => step.index === reference.pinned) ?? null;

  return (
    <>
      <div className="flex rounded border border-ink-750 overflow-hidden flex-shrink-0">
        {COMPARE_MODES.map(mode => {
          // Holding B is a momentary Before, so the control says Before while
          // it is held rather than leaving the key's effect unaccounted for.
          const active = viewer.holdingBefore
            ? mode.id === 'before'
            : viewer.compareMode === mode.id;
          // A pinned reference renames the segment after the thing it shows.
          // "Before" is only the right word while the two sides are the same
          // picture; once they are not, the useful label is which step.
          const label = mode.id === 'before' && pinnedStep ? pinnedStep.label : mode.label;
          return (
            <button
              key={mode.id}
              onClick={() => viewer.onCompareModeChange(mode.id)}
              aria-pressed={active}
              title={mode.id === 'before'
                ? pinnedStep
                  ? `${pinnedStep.label}, in full — the step pinned as the reference`
                  : `${mode.title} — or hold B`
                : mode.title}
              className={`px-2 h-[20px] text-[11px] font-medium border-r border-ink-750 last:border-r-0
                max-w-[14ch] truncate transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-500 ${
                  active ? 'bg-accent-500/16 text-accent-300' : 'text-ink-500 hover:text-ink-300'
                }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* The pin sits beside the group rather than inside it: choosing which
          picture is on the left is not a fourth compare mode, and putting it
          in that row would make it look like one. */}
      {reference && reference.steps.length > 1 && (
        <div className="relative flex-shrink-0">
          <button
            onClick={() => setPinMenuOpen(open => !open)}
            aria-expanded={pinMenuOpen}
            aria-haspopup="menu"
            aria-label="Pin a step as the reference"
            title={pinnedStep
              ? `Comparing against ${pinnedStep.label}. Pick another step, or unpin to compare this frame against itself.`
              : 'Compare against another step of the chain instead of against this one ungraded'}
            className={`inline-flex items-center gap-0.5 h-[20px] px-1 rounded border text-[11px] transition-colors
              focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-500 ${
                pinnedStep
                  ? 'border-accent-500/50 bg-accent-500/12 text-accent-300'
                  : 'border-ink-750 text-ink-500 hover:text-ink-300'
              }`}
          >
            <Pin className="w-3 h-3" />
            <ChevronDown className="w-2.5 h-2.5" />
          </button>
          {pinMenuOpen && (
            <>
              <span className="fixed inset-0 z-40" aria-hidden="true" onClick={() => setPinMenuOpen(false)} />
              <div
                role="menu"
                className="absolute right-0 top-[23px] z-50 min-w-[196px] rounded border border-ink-750 bg-ink-900 shadow-lg overflow-hidden font-sans"
              >
                <span className="block px-2 pt-1.5 pb-1 text-[10px] text-ink-600">
                  Show on the left of the split
                </span>
                <button
                  role="menuitem"
                  onClick={() => { setPinMenuOpen(false); reference.onPin(null); }}
                  className={`w-full px-2 py-1 text-left text-[11px] transition-colors hover:bg-ink-850 ${
                    reference.pinned === null ? 'text-accent-300' : 'text-ink-300'
                  }`}
                >
                  This step, ungraded
                  <span className="block text-[10px] text-ink-600">the ordinary before / after</span>
                </button>
                <span className="block h-px bg-ink-800" aria-hidden="true" />
                {reference.steps.map(step => (
                  <button
                    key={step.index}
                    role="menuitem"
                    onClick={() => { setPinMenuOpen(false); reference.onPin(step.index); }}
                    className={`w-full px-2 py-1 flex items-center gap-2 text-left text-[11px] transition-colors hover:bg-ink-850 ${
                      reference.pinned === step.index ? 'text-accent-300' : 'text-ink-300'
                    }`}
                  >
                    <span className="font-mono text-[9px] text-ink-600">{step.index}</span>
                    <span className="truncate">{step.label}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <button
        onClick={() => viewer.onShowClippingChange(!viewer.showClipping)}
        disabled={!viewer.canShowClipping}
        aria-pressed={viewer.showClipping}
        aria-label="Show clipping"
        title={viewer.canShowClipping
          ? 'Stripe the pixels sitting on the clip point — red at the top, blue at the bottom. Follows the grade as you drag it.'
          : 'No picture going through the grade to stripe'}
        className={`inline-flex items-center gap-1 h-[20px] px-1.5 rounded border text-[11px] font-medium
          whitespace-nowrap flex-shrink-0 transition-colors disabled:opacity-40 disabled:cursor-not-allowed
          focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-500 ${
            viewer.showClipping
              ? 'border-accent-500/50 bg-accent-500/12 text-accent-300'
              : 'border-ink-750 text-ink-500 hover:text-ink-300'
          }`}
      >
        <Ban className="w-3 h-3" />
        Clipping
      </button>
    </>
  );
});

/** VapourSynth's _ColorRange, as words. */
const RANGE_NAMES: Record<number, string> = { 0: 'full', 1: 'limited' };

/**
 * Does this look like limited-range video being read as full?
 *
 * The signature is both ends at once: a floor near 16 and a ceiling near 235,
 * in a picture that should be reaching 0 and 255. The ceiling is the
 * discriminating half — plenty of legitimate footage never goes near black,
 * but very little of it stops dead at 235.
 *
 * Deliberately narrow. A hint that fires on a merely dark shot would be worse
 * than no hint, because it would teach you to ignore it.
 */
function looksLimitedAsFull(frame: ChainPreviewFrame | null): boolean {
  const y = frame?.levels?.y;
  if (!y) return false;
  return y.low >= 13 && y.low <= 19 && y.high >= 231 && y.high <= 239;
}

interface PreviewStepRailProps {
  steps: ChainPreviewStep[];
  selected: number;
  isRendering: boolean;
  isStale: boolean;
  /**
   * First step whose picture carries a grade baked in when the script loaded.
   * That step and everything after it cannot follow a live drag, so they are
   * shown as unavailable rather than as a stale truth.
   */
  bakedFromStep?: number | null;
  /** The frame on screen, for its levels and its tagging. */
  frame?: ChainPreviewFrame | null;
  frameSize: { width: number; height: number } | null;
  /** Present while a grade is open. The bar shows with no steps for it. */
  viewer?: ViewerControls | null;
  onSelect: (index: number) => void;
  onReload: () => void;
}

export const PreviewStepRail = memo<PreviewStepRailProps>(({
  steps,
  selected,
  isRendering,
  isStale,
  bakedFromStep = null,
  frame = null,
  frameSize,
  viewer = null,
  onSelect,
  onReload,
}: PreviewStepRailProps) => {
  // Bound to the window rather than the rail: the picture has focus while a
  // grader is working, and reaching for a step should not need a click first.
  useEffect(() => {
    if (isStale || steps.length === 0) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const target = event.target as HTMLElement | null;
      if (target && (
        target.isContentEditable ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
      )) return;

      if (!/^[0-9]$/.test(event.key)) return;
      // vs-view's mapping: "1" is the first tab, "0" is the tenth.
      const position = event.key === '0' ? 9 : Number(event.key) - 1;
      const step = steps[position];
      if (!step) return;
      if (bakedFromStep !== null && step.index >= bakedFromStep) return;

      event.preventDefault();
      onSelect(step.index);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [steps, isStale, bakedFromStep, onSelect]);

  const luma = frame?.levels?.y ?? null;
  const rangeHint = looksLimitedAsFull(frame);

  const levelsTitle = frame?.levels
    ? [
        'Code values in this frame, 0-255.',
        `luma    ${frame.levels.y.min.toFixed(0)} .. ${frame.levels.y.max.toFixed(0)}  (0.1% ${frame.levels.y.low.toFixed(1)}, 99.9% ${frame.levels.y.high.toFixed(1)})`,
        `red     ${frame.levels.r.min.toFixed(0)} .. ${frame.levels.r.max.toFixed(0)}`,
        `green   ${frame.levels.g.min.toFixed(0)} .. ${frame.levels.g.max.toFixed(0)}`,
        `blue    ${frame.levels.b.min.toFixed(0)} .. ${frame.levels.b.max.toFixed(0)}`,
        frame.source
          ? `
Source: ${frame.source.format ?? 'unknown format'}, range ${
              frame.source.colorRange === null
                ? 'untagged'
                : RANGE_NAMES[frame.source.colorRange] ?? String(frame.source.colorRange)
            }`
          : '',
      ].join('\n')
    : undefined;

  // With a grade open and no session, there are no steps but there is still a
  // picture and still two ways of looking at it, so the bar stays.
  if (steps.length === 0 && !viewer) return null;

  if (isStale) {
    return (
      <div className="flex-shrink-0 h-8 px-3 flex items-center gap-2.5 bg-warn-500/10 border-b border-warn-500/30">
        <Layers className="w-3.5 h-3.5 text-warn-400 flex-shrink-0" />
        <span className="text-[11px] text-warn-200 min-w-0 truncate">
          The chain changed. Reload to preview it.
        </span>
        <button
          onClick={onReload}
          className="ml-auto h-[21px] px-2 rounded inline-flex items-center gap-1.5 text-[11px] font-medium border border-warn-500/50 text-warn-200 hover:bg-warn-500/15 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warn-500"
        >
          <RefreshCw className="w-3 h-3" />
          Reload
        </button>
        {/* The chain being stale says nothing about how you are looking at the
            frame already on screen, so these do not go away with it. */}
        {viewer && <ViewerGroup viewer={viewer} />}
      </div>
    );
  }

  return (
    <div className="flex-shrink-0 h-8 flex items-stretch bg-ink-900 border-b border-ink-800">
      <div className="flex items-stretch min-w-0 flex-1 overflow-x-auto">
        {steps.map((step, position) => {
          const isSelected = step.index === selected;
          const isBaked = bakedFromStep !== null && step.index >= bakedFromStep;
          return (
            <button
              key={step.index}
              onClick={() => onSelect(step.index)}
              disabled={isBaked}
              aria-pressed={isSelected}
              title={isBaked
                ? `${step.label} — not available while grading: it carries the grade values the script loaded with, not the ones being dragged. Close the grade to see it.`
                : `${step.label} — ${step.width}×${step.height}${position < 10 ? ` (${position === 9 ? 0 : position + 1})` : ''}`}
              className={`px-2.5 flex items-center gap-1.5 border-r border-ink-800 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-500 ${
                isBaked
                  ? 'text-ink-700 cursor-not-allowed'
                  : isSelected
                    ? 'bg-accent-500/12 text-accent-300 shadow-[inset_0_-2px_0_rgb(var(--accent-500))]'
                    : 'text-ink-500 hover:text-ink-300 hover:bg-ink-850'
              }`}
            >
              {position < 10 && (
                <span
                  className={`text-[9px] font-mono leading-none px-1 py-0.5 rounded-sm border ${
                    isBaked ? 'border-ink-800' : isSelected ? 'border-accent-500/50' : 'border-ink-750'
                  }`}
                >
                  {position === 9 ? 0 : position + 1}
                </span>
              )}
              <span className="text-[11px] font-medium max-w-[16ch] truncate">{step.label}</span>
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2.5 px-3 flex-shrink-0 text-[10.5px] font-mono tabular-nums text-ink-600">
        {viewer && <ViewerGroup viewer={viewer} />}

        {bakedFromStep !== null && (
          <span className="text-ink-600 font-sans">Grading — later steps hold the loaded grade</span>
        )}

        {rangeHint && (
          <span
            className="inline-flex items-center gap-1 h-[18px] px-1.5 rounded border border-warn-500/45 bg-warn-500/10 text-warn-300 font-sans"
            title={'The picture stops at 16 and 235 rather than 0 and 255, which is what limited-range video looks like when it is read as full. If that is the case, the fix is the tagging, not the grade.'}
          >
            <AlertTriangle className="w-3 h-3" />
            range?
          </span>
        )}

        {/* Luma floor and ceiling: the number you would otherwise be
            estimating from the height of a line on the waveform. */}
        {luma && (
          <span className="text-ink-400" title={levelsTitle}>
            Y {luma.low.toFixed(0)}–{luma.high.toFixed(0)}
          </span>
        )}

        {frameSize && <span>{frameSize.width}×{frameSize.height}</span>}
        {isRendering && <Loader2 className="w-3 h-3 text-accent-500 animate-spin" />}
      </div>

    </div>
  );
});
