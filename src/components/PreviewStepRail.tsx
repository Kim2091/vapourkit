// src/components/PreviewStepRail.tsx — the filter chain, as selectable steps.
//
// One tab per output the preview session exposes: the source, then each
// enabled filter in order. Number keys select, the way vs-view's output tabs
// do, because that is the shortcut anyone coming from it already has in their
// fingers — 1 is the first tab, and 0 is the tenth.

import { memo, useEffect } from 'react';
import { Loader2, RefreshCw, Layers } from 'lucide-react';
import type { ChainPreviewStep } from '../hooks/useChainPreview';

interface PreviewStepRailProps {
  steps: ChainPreviewStep[];
  selected: number;
  isRendering: boolean;
  isStale: boolean;
  frameSize: { width: number; height: number } | null;
  onSelect: (index: number) => void;
  onReload: () => void;
}

export const PreviewStepRail = memo<PreviewStepRailProps>(({
  steps,
  selected,
  isRendering,
  isStale,
  frameSize,
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

      event.preventDefault();
      onSelect(step.index);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [steps, isStale, onSelect]);

  if (steps.length === 0) return null;

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
      </div>
    );
  }

  return (
    <div className="flex-shrink-0 h-8 flex items-stretch bg-ink-900 border-b border-ink-800">
      <div className="flex items-stretch min-w-0 flex-1 overflow-x-auto">
        {steps.map((step, position) => {
          const isSelected = step.index === selected;
          return (
            <button
              key={step.index}
              onClick={() => onSelect(step.index)}
              aria-pressed={isSelected}
              title={`${step.label} — ${step.width}×${step.height}${position < 10 ? ` (${position === 9 ? 0 : position + 1})` : ''}`}
              className={`px-2.5 flex items-center gap-1.5 border-r border-ink-800 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-500 ${
                isSelected
                  ? 'bg-accent-500/12 text-accent-300 shadow-[inset_0_-2px_0_rgb(var(--accent-500))]'
                  : 'text-ink-500 hover:text-ink-300 hover:bg-ink-850'
              }`}
            >
              {position < 10 && (
                <span
                  className={`text-[9px] font-mono leading-none px-1 py-0.5 rounded-sm border ${
                    isSelected ? 'border-accent-500/50' : 'border-ink-750'
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
        {frameSize && <span>{frameSize.width}×{frameSize.height}</span>}
        {isRendering && <Loader2 className="w-3 h-3 text-accent-500 animate-spin" />}
      </div>
    </div>
  );
});
