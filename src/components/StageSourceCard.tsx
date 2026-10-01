// src/components/StageSourceCard.tsx — the one choice a step that reads
// another step's picture ever has to make.
//
// A dropdown, and nothing under it while the choice is working. The dropdown
// already reads "Step 10, Create LUT"; a sentence beneath repeating that back
// was the card's largest block and its least useful one. The dropdown only
// offers steps that can actually be read from, so what is left underneath is
// never about a bad choice — it is about a chain that moved after a good one,
// which is the only way this breaks and the only thing worth spending lines on.

import { memo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import type { Filter } from '../electron.d';
import { stepLabel } from '../hooks/useChainPreview';
import { chainsReadable, nameChain, stageLink, stageSourceId, stagesAbove } from '../utils/stageSource';
import { stepTag } from '../../electron/chainGraph';
import { encodeReferenceVideo, referenceVideoName } from '../../electron/referenceVideo';

const BOX = 'rounded-md border border-ink-800 bg-ink-950/40 p-2 space-y-1.5';
const HEADING = 'block text-[10px] font-display font-semibold uppercase tracking-[0.07em] text-ink-500';
const PROSE = 'text-[10.5px] leading-snug';
const SELECT = 'h-6 w-full rounded border border-ink-700 bg-ink-850 px-1.5 text-[11px] text-ink-200 '
  + 'focus:outline-none focus:border-accent-500 disabled:opacity-50';

const Warning = memo<{ children: React.ReactNode }>(({ children }) => (
  <p className={`${PROSE} text-warn-300 flex gap-1.5`}>
    <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-px text-warn-400" aria-hidden="true" />
    <span>{children}</span>
  </p>
));

/**
 * The one condition that makes a working reference fail, and why.
 *
 * It used to sit open as three permanent lines of grey under every healthy
 * card, warning about something that is fine almost always. The rule is short
 * enough to state in five words, so the rule stays and the reasoning behind it
 * is a click away.
 */
const FrameCountNote = memo(() => {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={`${PROSE} flex items-center gap-1 text-ink-600 hover:text-ink-400 transition-colors`}
      >
        {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        Both clips have to be the same length
      </button>
      {open && (
        <p className={`${PROSE} text-ink-500 mt-1 pl-4`}>
          A step in between that adds or drops frames is refused by name. Everything above the
          reference is also asked for its frames a second time here, which the frame cache
          usually absorbs.
        </p>
      )}
    </div>
  );
});

/**
 * Which reference frame lines up with the source's first frame.
 *
 * Typed as a draft and committed on blur or Enter, so clearing the box to type
 * a new number does not regenerate the script around a zero on the way.
 */
const OffsetInput = memo<{ value: number; disabled?: boolean; onCommit: (offset: number) => void }>(({
  value, disabled, onCommit,
}) => {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const parsed = Math.trunc(Number(draft));
    setDraft(null);
    if (Number.isFinite(parsed) && parsed !== value) onCommit(parsed);
  };
  return (
    <label
      className="flex items-center gap-2"
      title="The reference frame that lines up with the source's first frame. Positive skips frames at the start of the reference; negative holds its first frame for that many frames."
    >
      <span className={`${HEADING} flex-1`}>Reference offset (frames)</span>
      <input
        type="number"
        step={1}
        value={draft ?? String(value)}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Enter') commit(); }}
        className="h-6 w-20 rounded border border-ink-700 bg-ink-850 px-1.5 text-[11px] tabular-nums text-ink-200 focus:outline-none focus:border-accent-500 disabled:opacity-50"
      />
    </label>
  );
});

/** Not step ids: what the file entries of the dropdown carry. */
const PICK_FILE = '\u0000pick-file';
const CHOSEN_FILE = '\u0000chosen-file';

/** How a separate file is lined up, folded like FrameCountNote. */
const ReferenceFileNote = memo(() => {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={`${PROSE} flex items-center gap-1 text-ink-600 hover:text-ink-400 transition-colors`}
      >
        {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        Matched by time, so the frame rate can differ
      </button>
      {open && (
        <p className={`${PROSE} text-ink-500 mt-1 pl-4`}>
          Each frame gets the reference frame nearest it in time, so a 23.976 encode can guide a
          29.97 DVD. For telecined sources, IVTC first for an exact match. The framing has to be
          the same; the size does not. Past either end its nearest frame is held.
        </p>
      )}
    </div>
  );
});

/** How a side chain is lined up with the step reading it, folded like FrameCountNote. */
const SideChainNote = memo(() => {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={`${PROSE} flex items-center gap-1 text-ink-600 hover:text-ink-400 transition-colors`}
      >
        {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        Matched by time, so the frame rate can differ
      </button>
      {open && (
        <p className={`${PROSE} text-ink-500 mt-1 pl-4`}>
          Each frame gets the side chain's frame nearest it in time. Line the video up inside the
          side chain — Trim to drop a lead-in, IVTC, Crop to match the framing.
        </p>
      )}
    </div>
  );
});

interface StageSourceCardProps {
  filter: Filter;
  filters: Filter[];
  /** The template variable holding the chosen step's id. */
  variable: string;
  label?: string;
  disabled?: boolean;
  onChoose: (sourceId: string) => void;
  /** Offer a video file outside the chain; the filter has to declare it can take one. */
  onPickVideo?: () => Promise<string | null>;
}

export const StageSourceCard = memo<StageSourceCardProps>(({
  filter, filters, variable, label, disabled, onChoose, onPickVideo,
}) => {
  const chosen = stageSourceId(filter, variable);
  const link = stageLink(filters, filter, variable);
  const offered = stagesAbove(filters, filter);
  // A step that has gone wrong is no longer offered, so it is added back by
  // hand: the choice on screen has to be the choice that was made, with the
  // reason it stopped working underneath it rather than a silent reset to
  // something else.
  const chosenElsewhere = 'step' in link && !offered.some(step => step.id === link.step.id) ? link.step : null;
  const video = link.state === 'file' ? link.video : null;
  const chains = chainsReadable(filters, filter);
  // The same for a side chain that stopped working after it was picked.
  const chainElsewhere = 'chain' in link && !chains.some(chain => chain.id === link.chain.id) ? link : null;
  const inSideChain = Boolean(filter.chain);

  const choose = async (value: string) => {
    if (value === CHOSEN_FILE) return;
    if (value !== PICK_FILE) {
      onChoose(value);
      return;
    }
    // Cancelling leaves the choice as it was; the select snaps back to it.
    const path = await onPickVideo?.();
    if (path) onChoose(encodeReferenceVideo({ path, offset: video?.offset ?? 0 }));
  };

  return (
    <div className={BOX}>
      <span className={HEADING}>{label || 'Match the colour of'}</span>
      <select
        value={video ? CHOSEN_FILE : chosen}
        disabled={disabled}
        onChange={(event) => { void choose(event.target.value); }}
        title={video?.path}
        className={SELECT}
      >
        <option value="">{inSideChain ? "This side chain's video, before any filter" : 'The source, before any filter'}</option>
        {(offered.length > 0 || chosenElsewhere) && (
          <optgroup label="The picture at an earlier step">
            {offered.map(step => (
              <option key={step.id} value={step.id}>
                Step {stepTag(filters, step.id)}, {stepLabel(step)}
              </option>
            ))}
            {chosenElsewhere && (
              <option value={chosenElsewhere.id}>
                Step {stepTag(filters, chosenElsewhere.id)}, {stepLabel(chosenElsewhere)}
              </option>
            )}
          </optgroup>
        )}
        {(chains.length > 0 || chainElsewhere) && (
          <optgroup label="Side chains">
            {chains.map(chain => {
              const named = nameChain(filters, chain);
              return <option key={chain.id} value={chain.id}>{named.letter}. {named.label}</option>;
            })}
            {chainElsewhere && (
              <option value={chainElsewhere.chain.id}>{chainElsewhere.letter}. {chainElsewhere.label}</option>
            )}
          </optgroup>
        )}
        {link.state === 'missing' && (
          <option value={chosen}>A step that is no longer in the chain</option>
        )}
        {(onPickVideo || video) && (
          <optgroup label="Another video">
            {video && <option value={CHOSEN_FILE}>{referenceVideoName(video)}</option>}
            {onPickVideo && (
              <option value={PICK_FILE}>{video ? 'Choose a different video file…' : 'A video file…'}</option>
            )}
          </optgroup>
        )}
      </select>

      {link.state === 'source' && (
        <p className={`${PROSE} text-ink-500`}>
          {onPickVideo
            ? 'Pick a step partway down the chain, or a separate video of the same footage, to match against instead.'
            : 'Pick a step to match against the picture partway down the chain instead.'}
        </p>
      )}
      {video && (
        <>
          <OffsetInput
            value={video.offset}
            disabled={disabled}
            onCommit={(offset) => onChoose(encodeReferenceVideo({ ...video, offset }))}
          />
          <ReferenceFileNote />
        </>
      )}
      {link.state === 'ready' && <FrameCountNote />}
      {link.state === 'chain' && <SideChainNote />}
      {link.state === 'chainOff' && (
        <Warning>
          Side chain {link.letter}, {link.label}, is turned off or has no video chosen, so there is no picture to read.
        </Warning>
      )}
      {link.state === 'chainLoop' && (
        <Warning>
          {inSideChain
            ? `A side chain can only read one that starts above it. Side chain ${link.letter} does not.`
            : `Side chain ${link.letter} cannot be read from here.`}
        </Warning>
      )}
      {link.state === 'otherChain' && (
        <Warning>
          Step {link.tag}, {link.label}, is inside another chain. Pick that whole side chain instead; its last step is what it hands on.
        </Warning>
      )}
      {link.state === 'missing' && (
        <Warning>The step this was reading from is gone. Pick another, or the source.</Warning>
      )}
      {link.state === 'self' && (
        <Warning>A step cannot read its own picture. Pick one above it, or the source.</Warning>
      )}
      {link.state === 'disabled' && (
        <Warning>
          Step {link.tag}, {link.label}, is turned off, so there is no picture there to read.
        </Warning>
      )}
      {link.state === 'below' && (
        <Warning>
          Step {link.tag}, {link.label}, is below this one. A step can only read the picture from
          one above it — move this below it, or pick another.
        </Warning>
      )}
      {link.state === 'silent' && (
        <Warning>
          Step {link.tag}, {link.label},{' '}
          {link.step.filterType === 'aiModel'
            ? 'has no model chosen, so it produces no picture to read.'
            : 'is empty, so it produces no picture to read.'}
        </Warning>
      )}
    </div>
  );
});
