// src/components/TitleStrip.tsx — 44px data strip across the top.
//
// The old header spent 80px on buttons whose labels repeated their tooltips,
// a centred wordmark with a tagline, and three bordered boxes for workflow,
// GPU and privacy. This carries the same information as data: chips and
// meters, no boxes around boxes. See docs/design/README.md.

import { memo, useMemo, useState, useRef, useEffect } from 'react';
import { Cpu, ChevronDown, Check, X, FileCheck2, Undo, Redo, Lock } from 'lucide-react';
import type { BackendId } from '../electron.d';
import { BACKENDS, getBackendDescriptor } from '../utils/backends';

interface TitleStripProps {
  isProcessing: boolean;
  defaultBackend: BackendId;
  onChangeBackend: (backend: BackendId) => void;
  workflowName?: string | null;
  onClearWorkflow?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  privacyMode: boolean;
  gpuStats?: { gpuMemoryUsed: number; gpuMemoryTotal: number; gpuUtilization: number } | null;
}

/** Semantic, not decorative — these do not move with the accent. */
const colorForPercent = (pct: number) => {
  if (pct >= 90) return { bar: 'bg-bad-500', text: 'text-bad-400' };
  if (pct >= 70) return { bar: 'bg-warn-500', text: 'text-warn-400' };
  return { bar: 'bg-ok-500', text: 'text-ok-400' };
};

const Meter = ({ label, percent, value, tone }: {
  label: string;
  percent: number;
  value: string;
  tone: { bar: string; text: string };
}) => (
  <div className="flex items-center gap-1.5">
    <span className="text-[10px] font-display uppercase tracking-[0.1em] text-ink-500 leading-none">{label}</span>
    <div className="w-[60px] h-[5px] rounded-full bg-ink-800 overflow-hidden">
      <div className={`h-full rounded-full transition-all duration-500 ${tone.bar}`} style={{ width: `${percent}%` }} />
    </div>
    <span className={`text-[12px] font-medium tabular-nums ${tone.text}`}>{value}</span>
  </div>
);

export const TitleStrip = memo<TitleStripProps>(({
  isProcessing,
  defaultBackend,
  onChangeBackend,
  workflowName,
  onClearWorkflow,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  privacyMode,
  gpuStats,
}: TitleStripProps) => {
  const vramPercent = useMemo(() => {
    if (gpuStats?.gpuMemoryUsed != null && gpuStats?.gpuMemoryTotal) {
      return Math.round((gpuStats.gpuMemoryUsed / gpuStats.gpuMemoryTotal) * 100);
    }
    return null;
  }, [gpuStats?.gpuMemoryUsed, gpuStats?.gpuMemoryTotal]);

  const [showBackendMenu, setShowBackendMenu] = useState(false);
  const backendMenuRef = useRef<HTMLDivElement>(null);
  const activeBackend = getBackendDescriptor(defaultBackend);

  useEffect(() => {
    if (!showBackendMenu) return;
    const onClickOutside = (event: MouseEvent) => {
      if (backendMenuRef.current && !backendMenuRef.current.contains(event.target as Node)) {
        setShowBackendMenu(false);
      }
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowBackendMenu(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onEscape);
    };
  }, [showBackendMenu]);

  return (
    <div className="h-11 flex-shrink-0 flex items-center gap-4 px-4 bg-ink-900 border-b border-ink-800">
      <span className="font-display text-[13.5px] font-semibold uppercase tracking-[0.16em] text-ink-200 select-none whitespace-nowrap">
        Vapourkit
      </span>

      <span className="w-px h-5 bg-ink-800 flex-shrink-0" />

      {workflowName && (
        <span
          className="inline-flex items-center gap-2 h-[26px] pl-2 pr-1.5 rounded-md border border-accent-500/45 bg-accent-500/12 text-accent-400 text-[12px] max-w-[240px]"
          title={`Active workflow: ${workflowName}`}
        >
          <FileCheck2 className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="truncate">{workflowName}</span>
          {onClearWorkflow && (
            <button
              onClick={onClearWorkflow}
              title="Clear workflow and restore previous settings"
              aria-label="Clear workflow"
              className="p-0.5 rounded text-accent-400/70 hover:text-accent-300 hover:bg-accent-500/20 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-500"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </span>
      )}

      {/* Default inference backend — options come from the shared registry */}
      <div className="relative flex-shrink-0" ref={backendMenuRef}>
        <button
          onClick={() => setShowBackendMenu(v => !v)}
          className="inline-flex items-center gap-2 h-[26px] px-2.5 rounded-md border border-ink-750 bg-ink-850 text-[12px] text-ink-400 hover:text-ink-200 hover:border-ink-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
          title={`Default backend: ${activeBackend.label} — ${activeBackend.description}`}
          aria-haspopup="menu"
          aria-expanded={showBackendMenu}
        >
          <Cpu className="w-3.5 h-3.5" />
          <span className="font-semibold text-ink-200">{activeBackend.shortLabel}</span>
          <ChevronDown className={`w-3.5 h-3.5 text-ink-500 transition-transform ${showBackendMenu ? 'rotate-180' : ''}`} />
        </button>

        {showBackendMenu && (
          <div
            role="menu"
            className="absolute left-0 top-full mt-1 z-50 w-72 bg-ink-850 border border-ink-750 rounded-lg shadow-xl shadow-black/50 overflow-hidden"
          >
            <div className="px-3 py-2 text-[10px] font-display uppercase tracking-[0.14em] text-ink-500 border-b border-ink-800">
              Default inference backend
            </div>
            {BACKENDS.map(backend => (
              <button
                key={backend.id}
                onClick={() => {
                  setShowBackendMenu(false);
                  if (backend.id !== defaultBackend) onChangeBackend(backend.id);
                }}
                className={`w-full text-left px-3 py-2 flex items-start gap-2 transition-colors hover:bg-ink-800 ${
                  backend.id === defaultBackend ? 'bg-ink-800/60' : ''
                }`}
                role="menuitemradio"
                aria-checked={backend.id === defaultBackend}
              >
                <div className="w-4 pt-0.5 flex-shrink-0">
                  {backend.id === defaultBackend && <Check className="w-4 h-4 text-accent-500" />}
                </div>
                <div className="min-w-0">
                  <div className={`text-sm font-medium ${backend.id === defaultBackend ? 'text-ink-200' : 'text-ink-300'}`}>
                    {backend.label}
                  </div>
                  <div className="text-xs text-ink-500 leading-snug">{backend.description}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0" />

      {privacyMode && (
        <span
          className="inline-flex items-center gap-2 h-[26px] px-2.5 rounded-md border border-warn-500/40 bg-warn-500/15 text-warn-400 text-[12px] font-medium flex-shrink-0"
          title="Privacy mode is on — previews and filenames are hidden"
        >
          <Lock className="w-3.5 h-3.5" />
          Privacy
        </span>
      )}

      {(onUndo || onRedo) && (
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {onUndo && (
            <button
              onClick={onUndo}
              disabled={!canUndo || isProcessing}
              title="Undo (Ctrl+Z)"
              aria-label="Undo"
              className="w-8 h-[30px] rounded-md grid place-items-center text-ink-400 hover:text-ink-200 hover:bg-ink-850 transition-colors disabled:opacity-30 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
            >
              <Undo className="w-4 h-4" />
            </button>
          )}
          {onRedo && (
            <button
              onClick={onRedo}
              disabled={!canRedo || isProcessing}
              title="Redo (Ctrl+Y)"
              aria-label="Redo"
              className="w-8 h-[30px] rounded-md grid place-items-center text-ink-400 hover:text-ink-200 hover:bg-ink-850 transition-colors disabled:opacity-30 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
            >
              <Redo className="w-4 h-4" />
            </button>
          )}
        </div>
      )}

      {gpuStats && vramPercent != null && (
        <>
          <span className="w-px h-5 bg-ink-800 flex-shrink-0" />
          <div
            className="flex items-center gap-3 flex-shrink-0"
            title={`VRAM: ${gpuStats.gpuMemoryUsed}MB / ${gpuStats.gpuMemoryTotal}MB\nGPU load: ${gpuStats.gpuUtilization}%`}
          >
            <Meter
              label="VRAM"
              percent={vramPercent}
              value={`${(gpuStats.gpuMemoryUsed / 1024).toFixed(1)}/${(gpuStats.gpuMemoryTotal / 1024).toFixed(1)} GB`}
              tone={colorForPercent(vramPercent)}
            />
            <Meter
              label="GPU"
              percent={gpuStats.gpuUtilization}
              value={`${gpuStats.gpuUtilization}%`}
              tone={colorForPercent(gpuStats.gpuUtilization)}
            />
          </div>
        </>
      )}
    </div>
  );
});
