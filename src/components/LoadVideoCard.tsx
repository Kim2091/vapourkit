// src/components/LoadVideoCard.tsx — the row that starts a side chain.
//
// A Load Video is not a filter: it opens a second video, and the steps under
// it run on that video instead of the main one (electron/chainGraph.ts). Its
// row is the same height as any step's, and everything it has to say fits on
// it: which video, how many steps hang off it, and a + to add another. The
// file's full path lives in tooltips, and opening the row adds one line —
// rename, or change the video — rather than a card of its own.
//
// Its colour is the side chain's own (chain-*, a periwinkle), never the teal
// accent and never a state colour: being a side chain is not a condition.

import { memo, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Film, FolderOpen, GripVertical, Plus, Sparkles, Filter as LucideFilter, X } from 'lucide-react';
import type { Filter } from '../electron.d';

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
  onAddStep: (kind: 'custom' | 'aiModel') => void;
  dragProps: React.HTMLAttributes<HTMLDivElement> & { draggable?: boolean };
}

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

const ICON_BUTTON = 'p-1 rounded flex-shrink-0 transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

export const LoadVideoCard = memo<LoadVideoCardProps>(({
  filter, tag, stepCount, folded, disabled, onFold, onToggle, onRemove, onRename, onPickVideo, onChooseVideo, onAddStep, dragProps,
}) => {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  // Typed as a draft and committed on blur or Enter, so the script is not
  // regenerated around every keystroke.
  const [draft, setDraft] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const named = filter.preset && filter.preset !== 'Load Video' ? filter.preset : '';
  const title = named || (filter.sourcePath ? fileName(filter.sourcePath) : 'Load Video');

  // The add menu closes on any click outside it, like the panel's own.
  useEffect(() => {
    if (!adding) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setAdding(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [adding]);

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

  const add = (kind: 'custom' | 'aiModel') => {
    setAdding(false);
    onAddStep(kind);
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
          </span>
        </button>

        <div className="relative flex-shrink-0" ref={menuRef}>
          <button
            type="button"
            onClick={() => setAdding(!adding)}
            disabled={disabled}
            className={`${ICON_BUTTON} ${adding ? 'text-chain-200 bg-chain-500/20' : 'text-chain-300 hover:text-chain-200 hover:bg-chain-500/15'}`}
            title={`Add a step to side chain ${tag}`}
            aria-haspopup="menu"
            aria-expanded={adding}
          >
            <Plus className="w-4 h-4" />
          </button>
          {adding && (
            <div role="menu" className="absolute right-0 top-full mt-1 bg-ink-850 border border-ink-750 rounded-lg shadow-xl shadow-black/50 z-50 min-w-[150px] overflow-hidden">
              <button
                type="button"
                role="menuitem"
                onClick={() => add('aiModel')}
                className="w-full px-3 py-1.5 text-left text-[12.5px] hover:bg-ink-800 transition-colors flex items-center gap-2 text-ink-200 border-b border-ink-800"
              >
                <Sparkles className="w-4 h-4 text-accent-400" />
                AI Model
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => add('custom')}
                className="w-full px-3 py-1.5 text-left text-[12.5px] hover:bg-ink-800 transition-colors flex items-center gap-2 text-ink-200"
              >
                <LucideFilter className="w-4 h-4 text-ink-400" />
                VS Filter
              </button>
            </div>
          )}
        </div>

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
        <div className="px-3 py-2 border-t border-chain-800 flex items-center gap-1.5">
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
        </div>
      )}
    </div>
  );
});
