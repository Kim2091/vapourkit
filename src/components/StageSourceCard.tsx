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
import { stepNumber } from '../utils/lutSteps';
import { stageLink, stageSourceId, stagesAbove } from '../utils/stageSource';

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

interface StageSourceCardProps {
  filter: Filter;
  filters: Filter[];
  /** The template variable holding the chosen step's id. */
  variable: string;
  label?: string;
  disabled?: boolean;
  onChoose: (sourceId: string) => void;
}

export const StageSourceCard = memo<StageSourceCardProps>(({
  filter, filters, variable, label, disabled, onChoose,
}) => {
  const chosen = stageSourceId(filter, variable);
  const link = stageLink(filters, filter, variable);
  const offered = stagesAbove(filters, filter);
  // A step that has gone wrong is no longer offered, so it is added back by
  // hand: the choice on screen has to be the choice that was made, with the
  // reason it stopped working underneath it rather than a silent reset to
  // something else.
  const chosenElsewhere = 'step' in link && !offered.some(step => step.id === link.step.id) ? link.step : null;

  return (
    <div className={BOX}>
      <span className={HEADING}>{label || 'Match the colour of'}</span>
      <select
        value={chosen}
        disabled={disabled}
        onChange={(event) => onChoose(event.target.value)}
        className={SELECT}
      >
        <option value="">The source, before any filter</option>
        {(offered.length > 0 || chosenElsewhere) && (
          <optgroup label="The picture at an earlier step">
            {offered.map(step => (
              <option key={step.id} value={step.id}>
                Step {stepNumber(filters, step.id)}, {stepLabel(step)}
              </option>
            ))}
            {chosenElsewhere && (
              <option value={chosenElsewhere.id}>
                Step {stepNumber(filters, chosenElsewhere.id)}, {stepLabel(chosenElsewhere)}
              </option>
            )}
          </optgroup>
        )}
        {link.state === 'missing' && (
          <option value={chosen}>A step that is no longer in the chain</option>
        )}
      </select>

      {link.state === 'source' && (
        <p className={`${PROSE} text-ink-500`}>
          Pick a step to match against the picture partway down the chain instead.
        </p>
      )}
      {link.state === 'ready' && <FrameCountNote />}
      {link.state === 'missing' && (
        <Warning>The step this was reading from is gone. Pick another, or the source.</Warning>
      )}
      {link.state === 'self' && (
        <Warning>A step cannot read its own picture. Pick one above it, or the source.</Warning>
      )}
      {link.state === 'disabled' && (
        <Warning>
          Step {link.number}, {link.label}, is turned off, so there is no picture there to read.
        </Warning>
      )}
      {link.state === 'below' && (
        <Warning>
          Step {link.number}, {link.label}, is below this one. A step can only read the picture from
          one above it — move this below it, or pick another.
        </Warning>
      )}
      {link.state === 'silent' && (
        <Warning>
          Step {link.number}, {link.label},{' '}
          {link.step.filterType === 'aiModel'
            ? 'has no model chosen, so it produces no picture to read.'
            : 'is empty, so it produces no picture to read.'}
        </Warning>
      )}
    </div>
  );
});
