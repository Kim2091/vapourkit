// src/components/LoadVideoCard.tsx — the row that starts a side chain.
//
// A Load Video is not a filter: it opens a second video, and the steps under
// it run on that video instead of the main one (electron/chainGraph.ts). So
// its row says the two things that matter and nothing else — which file, and
// how many steps hang off it — and folds the chain shut, since a reference
// that has been lined up is something you stop looking at.
//
// Its colour is the side chain's own (chain-*, a periwinkle), never the teal
// accent and never a state colour: being a side chain is not a condition.

import { memo, useState } from 'react';
import { ChevronDown, ChevronRight, Film, FolderOpen, GripVertical, X } from 'lucide-react';
import type { Filter } from '../electron.d';

const HEADING = 'block text-[10px] font-display font-semibold uppercase tracking-[0.07em] text-ink-500';
const PROSE = 'text-[10.5px] leading-snug';

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
  dragProps: React.HTMLAttributes<HTMLDivElement> & { draggable?: boolean };
}

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

export const LoadVideoCard = memo<LoadVideoCardProps>(({
  filter, tag, stepCount, folded, disabled, onFold, onToggle, onRemove, onRename, onPickVideo, onChooseVideo, dragProps,
}) => {
  const [open, setOpen] = useState(false);
  // Typed as a draft and committed on blur or Enter, like the reference
  // offset, so the script is not regenerated around every keystroke.
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
          title={folded ? 'Show this side chain\'s steps' : 'Fold this side chain shut'}
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
          className="flex-1 flex items-center gap-2 text-left min-w-0 hover:opacity-80 transition-opacity disabled:opacity-50"
          title={filter.sourcePath}
        >
          <span className="flex flex-col min-w-0">
            <span className="text-[12.5px] font-medium truncate text-ink-100">{title}</span>
            <span className="text-[10.5px] text-chain-300/80 truncate">
              Side chain · {stepCount === 0 ? 'no steps yet' : `${stepCount} step${stepCount === 1 ? '' : 's'}`}
              {folded && stepCount > 0 ? ' (folded)' : ''}
            </span>
          </span>
        </button>

        <button
          type="button"
          onClick={onFold}
          className="text-ink-400 hover:text-chain-300 p-1 rounded flex-shrink-0"
          title={folded ? 'Show steps' : 'Fold steps'}
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
          className="text-bad-400 hover:text-bad-300 hover:bg-bad-900/30 p-1 rounded transition-all disabled:opacity-50 flex-shrink-0"
          title={stepCount > 0 ? `Remove this side chain and its ${stepCount} step${stepCount === 1 ? '' : 's'}` : 'Remove this side chain'}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {filter.enabled && open && (
        <div className="px-3 pb-2.5 pt-2.5 space-y-2 border-t border-chain-800">
          <div className="flex gap-1.5">
            <div
              className="flex-1 min-w-0 h-7 bg-ink-850 border border-ink-750 rounded px-2 text-[12px] text-ink-300 flex items-center"
              title={filter.sourcePath}
            >
              <span className="truncate">{filter.sourcePath || 'No video chosen'}</span>
            </div>
            <button
              type="button"
              onClick={() => { void pick(); }}
              disabled={disabled}
              title="Choose a different video"
              className="h-7 px-2 rounded border border-chain-600/60 bg-chain-500/10 text-chain-300 hover:bg-chain-500/20 text-[11.5px] font-semibold inline-flex items-center gap-1.5 flex-shrink-0 disabled:opacity-50"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              Change
            </button>
          </div>
          <label className="flex items-center gap-2">
            <span className={`${HEADING} flex-shrink-0`}>Name</span>
            <input
              type="text"
              value={draft ?? named}
              placeholder={filter.sourcePath ? fileName(filter.sourcePath) : 'Side chain'}
              disabled={disabled}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => { if (e.key === 'Enter') commitName(); }}
              className="h-6 flex-1 min-w-0 rounded border border-ink-700 bg-ink-850 px-1.5 text-[11px] text-ink-200 focus:outline-none focus:border-chain-500 disabled:opacity-50"
            />
          </label>
          <p className={`${PROSE} text-ink-500`}>
            Steps added to this side chain run on this video, not the main one. A step in the main
            chain can read the result, like Guided Color Fix's “Match the colour of”.
          </p>
        </div>
      )}
    </div>
  );
});
