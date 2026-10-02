// src/components/LoadVideoCard.tsx — the row that starts a side chain.
//
// A Load Video is not a filter: it opens a second video, and the steps under
// it run on that video instead of the main one (electron/chainGraph.ts). Its
// row is the same height as any step's, and everything it has to say fits on
// it: which video and how many steps hang off it. Steps get in and out of
// the chain by dragging (DynamicFilterPanel). The file's full path lives in
// tooltips, and opening the row adds one line — rename, or change the video —
// rather than a card of its own.
//
// Its colour is the side chain's own (chain-*, a periwinkle), never the teal
// accent and never a state colour: being a side chain is not a condition.

import { memo, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Film, FolderOpen, GripVertical, Loader2, Timer, X } from 'lucide-react';
import type { Filter, SideChainAlignment } from '../electron.d';
import { samePath } from '../../electron/chainGraph';

interface LoadVideoCardProps {
  filter: Filter;
  /** The chain's letter in the rail: A, B, … */
  tag: string;
  /** Steps under it, disabled ones included. */
  stepCount: number;
  folded: boolean;
  disabled?: boolean;
  onFold: () => void;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
  onRename: (name: string) => void;
  onPickVideo: () => Promise<string | null>;
  onChooseVideo: (path: string) => void;
  /** The main video, which Align measures this one against. */
  mainVideoPath?: string;
  onAligned: (alignment: SideChainAlignment) => void;
  dragProps: React.HTMLAttributes<HTMLDivElement> & { draggable?: boolean };
}

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

/** m:ss, or h:mm:ss past an hour. */
function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** A signed offset in seconds, to the hundredth: "+0.04 s". */
const signed = (seconds: number) => `${seconds >= 0 ? '+' : '−'}${Math.abs(seconds).toFixed(2)} s`;

/**
 * One line under the Align button: progress while it runs, then what it
 * found. Said in the terms someone lining up two releases thinks in — how far
 * apart, how sure, and where the cuts differ — never as the raw mapping.
 */
const AlignStatus = memo<{
  aligning: { progress: number; message: string } | null;
  error: string | null;
  align?: SideChainAlignment;
  alignedHere: boolean;
}>(({ aligning, error, align, alignedHere }) => {
  const line = 'text-[10.5px] leading-snug';
  if (aligning) {
    return (
      <div className="space-y-1">
        <div className="h-1 rounded-full bg-ink-800 overflow-hidden">
          <div className="h-full bg-chain-400 transition-[width] duration-300" style={{ width: `${Math.round(aligning.progress * 100)}%` }} />
        </div>
        <p className={`${line} text-ink-400`}>{aligning.message}</p>
      </div>
    );
  }
  if (error) return <p className={`${line} text-warn-300`}>{error}</p>;
  if (!align) {
    return <p className={`${line} text-ink-500`}>Not aligned: frames are paired by time from the start of each video.</p>;
  }
  if (!alignedHere) {
    return (
      <p className={`${line} text-warn-300`}>
        Aligned to {fileName(align.alignedTo)}, not the video loaded now. Paired by time until it is aligned again.
      </p>
    );
  }
  const speed = Math.abs(align.speed - 1) > 1e-6 ? ` · speed ×${align.speed.toFixed(4)}` : '';
  const sure = `${align.matched} of ${align.usable} clear moments agree`;
  if (align.sections.length === 1) {
    return <p className={`${line} text-ink-400`}>Lined up {signed(align.sections[0].offset)}{speed} · {sure}</p>;
  }
  const cuts = align.sections.slice(1).map(section => clock(section.from)).join(', ');
  return (
    <p className={`${line} text-ink-400`}>
      {align.sections.length} sections, the releases differ at {cuts}{speed} · {sure}
    </p>
  );
});

const ICON_BUTTON = 'p-1 rounded flex-shrink-0 transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

export const LoadVideoCard = memo<LoadVideoCardProps>(({
  filter, tag, stepCount, folded, disabled, onFold, onToggle, onRemove, onRename, onPickVideo, onChooseVideo, mainVideoPath, onAligned, dragProps,
}) => {
  const [open, setOpen] = useState(false);
  const [aligning, setAligning] = useState<{ progress: number; message: string } | null>(null);
  const [alignError, setAlignError] = useState<string | null>(null);
  const align = filter.align;
  const alignedHere = Boolean(align && samePath(align.alignedTo, mainVideoPath));

  useEffect(() => window.electronAPI.onAlignProgress(progress => {
    if (progress.id === filter.id) setAligning({ progress: progress.progress, message: progress.message });
  }), [filter.id]);

  const runAlign = async () => {
    if (!mainVideoPath || !filter.sourcePath) return;
    setAlignError(null);
    setAligning({ progress: 0, message: 'Starting' });
    const outcome = await window.electronAPI.alignSideChain({ id: filter.id, mainPath: mainVideoPath, refPath: filter.sourcePath });
    setAligning(null);
    if (outcome.success) onAligned(outcome.alignment);
    else if (!outcome.cancelled) setAlignError(outcome.error);
  };
  // Typed as a draft and committed on blur or Enter, so the script is not
  // regenerated around every keystroke.
  const [draft, setDraft] = useState<string | null>(null);
  const named = filter.preset && filter.preset !== 'Load Video' ? filter.preset : '';
  const title = named || (filter.sourcePath ? fileName(filter.sourcePath) : 'Load Video');

  const commitName = () => {
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    if (next !== named) onRename(next || 'Load Video');
  };

  const pick = async () => {
    const path = await onPickVideo();
    if (path) onChooseVideo(path);
  };

  return (
    <div className={`bg-chain-900/40 rounded border border-chain-800 border-l-2 transition-colors ${
      filter.enabled ? (open ? 'border-l-chain-400' : 'border-l-chain-500/80') : 'border-l-transparent opacity-50'
    }`}>
      <div
        {...dragProps}
        className={`flex items-center gap-2.5 px-3 py-1.5 cursor-grab active:cursor-grabbing rounded-t-[3px] ${
          open ? 'bg-chain-900/60' : 'rounded-b-[3px] hover:bg-chain-900/60'
        }`}
      >
        <button
          type="button"
          onClick={onFold}
          title={folded ? 'Show this side chain\'s steps' : 'Fold this side chain\'s steps away'}
          aria-expanded={!folded}
          className="flex-shrink-0 w-5 h-5 rounded bg-chain-500/20 border border-chain-500/45 flex items-center justify-center text-chain-300 hover:bg-chain-500/30 transition-colors"
        >
          <span className="text-xs font-bold">{tag}</span>
        </button>

        <div className="text-ink-500 flex-shrink-0 pointer-events-none">
          <GripVertical className="w-4 h-4" />
        </div>

        <Film className="w-4 h-4 text-chain-400 flex-shrink-0" />

        <button
          type="button"
          onClick={() => filter.enabled && setOpen(!open)}
          disabled={!filter.enabled}
          className="flex-1 flex items-baseline gap-2 text-left min-w-0 hover:opacity-80 transition-opacity disabled:opacity-50"
          title={filter.sourcePath ? `Side chain on ${filter.sourcePath}` : 'Side chain'}
        >
          <span className="text-[12.5px] font-medium truncate text-ink-100">{title}</span>
          <span className="text-[11px] text-chain-300/70 flex-shrink-0 tabular-nums">
            {stepCount === 0 ? 'no steps' : `${stepCount} step${stepCount === 1 ? '' : 's'}`}
            {' · '}
            <span className={alignedHere ? 'text-chain-300' : 'text-ink-500'}>
              {aligning ? 'aligning…' : alignedHere ? 'aligned' : 'not aligned'}
            </span>
          </span>
        </button>

        <button
          type="button"
          onClick={onFold}
          className={`${ICON_BUTTON} text-ink-400 hover:text-chain-300`}
          title={folded ? 'Show steps' : 'Fold steps away'}
        >
          {folded ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>

        <input
          type="checkbox"
          checked={filter.enabled}
          onChange={(e) => onToggle(e.target.checked)}
          disabled={disabled}
          className="w-4 h-4 rounded border-ink-600 bg-ink-700 focus:ring-chain-500 focus:ring-2 focus:ring-offset-0 disabled:opacity-50 flex-shrink-0"
          title={filter.enabled ? 'Turn this side chain off' : 'Turn this side chain on'}
        />

        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          className={`${ICON_BUTTON} text-bad-400 hover:text-bad-300 hover:bg-bad-900/30`}
          title={stepCount > 0 ? `Remove this side chain and its ${stepCount} step${stepCount === 1 ? '' : 's'}` : 'Remove this side chain'}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {filter.enabled && open && (
        <div className="px-3 py-2 border-t border-chain-800 space-y-1.5">
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            aria-label="Side chain name"
            value={draft ?? named}
            placeholder={filter.sourcePath ? fileName(filter.sourcePath) : 'Side chain'}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => { if (e.key === 'Enter') commitName(); }}
            title="Name this side chain; empty uses the file name"
            className="h-7 flex-1 min-w-0 rounded border border-ink-700 bg-ink-850 px-2 text-[12px] text-ink-200 focus:outline-none focus:border-chain-500 disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => { void pick(); }}
            disabled={disabled}
            title={filter.sourcePath ? `Change the video (now ${filter.sourcePath})` : 'Choose the video'}
            className="h-7 w-7 grid place-items-center rounded border border-chain-600/60 bg-chain-500/10 text-chain-300 hover:bg-chain-500/20 flex-shrink-0 disabled:opacity-50"
          >
            <FolderOpen className="w-4 h-4" />
          </button>
          {aligning ? (
            <button
              type="button"
              onClick={() => { void window.electronAPI.cancelAlign(filter.id); }}
              title="Stop aligning"
              className="h-7 px-2 rounded border border-chain-600/60 bg-chain-500/15 text-chain-200 text-[11.5px] font-semibold inline-flex items-center gap-1.5 flex-shrink-0"
            >
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={() => { void runAlign(); }}
              disabled={disabled || !mainVideoPath || !filter.sourcePath}
              title={mainVideoPath
                ? 'Measure how this video lines up with the source, so each frame is matched to the same moment'
                : 'Load a source video first, to align this one against'}
              className="h-7 px-2 rounded border border-chain-500/70 bg-chain-500/20 text-chain-200 hover:bg-chain-500/30 text-[11.5px] font-semibold inline-flex items-center gap-1.5 flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Timer className="w-3.5 h-3.5" />
              {alignedHere ? 'Re-align' : 'Align'}
            </button>
          )}
        </div>
        <AlignStatus aligning={aligning} error={alignError} align={align} alignedHere={alignedHere} />
        </div>
      )}
    </div>
  );
});
