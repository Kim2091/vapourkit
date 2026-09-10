// src/components/LutStepCards.tsx — what a Create LUT and a Load LUT step
// show inside their cards in the filter list.
//
// Neither opens a surface. The one question either step ever had — which
// Create LUT a Load LUT puts back — is one dropdown, and everything else is
// read off where the two steps sit. What is left is the part that cannot be
// a menu: sometimes the answer is exact and sometimes it is fitted to real
// frames, the difference changes how much the result can be trusted, and how
// well a fit did is the whole basis for keeping it. So that is what the card
// spends its lines on — which engine will answer and why, before it runs;
// what it achieved, after.

import { memo } from 'react';
import { Loader2, Wand2, Plus, Save, AlertTriangle, RefreshCw, Check } from 'lucide-react';
import type { Filter } from '../electron.d';
import type { LutJob, LutResult } from '../hooks/useLutSteps';
import { DEFAULT_LUT_SIZE } from '../utils/lut';
import {
  bakeSpan, loadersOf, markerPlace, markersAbove, restoreFingerprint, restoreLink, stepNumber,
  type LutMethod,
} from '../utils/lutSteps';

const BOX = 'rounded-md border border-ink-800 bg-ink-950/40 p-2 space-y-1.5';
const HEADING = 'block text-[10px] font-display font-semibold uppercase tracking-[0.07em] text-ink-500';
const PROSE = 'text-[10.5px] leading-snug';
const SELECT = 'h-6 w-full rounded border border-ink-700 bg-ink-850 px-1.5 text-[11px] text-ink-200 '
  + 'focus:outline-none focus:border-accent-500 disabled:opacity-50';
const ACTION = 'h-6 px-2 rounded inline-flex items-center gap-1.5 text-[11px] font-medium transition-colors '
  + 'disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-500';
const PRIMARY = `${ACTION} bg-accent-500/10 border border-accent-500/40 text-accent-300 hover:bg-accent-500/20 hover:border-accent-500/60`;
const QUIET = `${ACTION} bg-ink-850 border border-ink-750 text-ink-400 hover:text-ink-200 hover:border-ink-700`;

const codes = (value: number) => value.toFixed(1);
const list = (items: string[]) => items.join(', ');

/** Which engine a span gets, said before it runs. */
const Method = memo<{ method: LutMethod; previewOpen: boolean }>(({ method, previewOpen }) => {
  if (method.kind === 'solve') {
    return (
      <p className={`${PROSE} text-accent-300`}>
        Exact — {list(method.captured)} {method.captured.length > 1 ? 'are' : 'is'} known, so this is
        solved rather than measured.
      </p>
    );
  }
  if (method.kind === 'measure') {
    return (
      <p className={`${PROSE} text-warn-300`}>
        Measured from frames — {method.because.label}: {method.because.reason}.
        {!previewOpen && ' Open the preview first: the frames come from it.'}
      </p>
    );
  }
  return null;
});

/** What a generate achieved, as one line under the button. */
const Outcome = memo<{ result: LutResult }>(({ result }) => (
  <div className="space-y-1">
    {result.method === 'measure' ? (
      <p className={`${PROSE} text-ink-400`}>
        <Check className="inline w-3 h-3 mr-1 text-ok-400 align-[-2px]" aria-hidden="true" />
        Measured over {result.frames?.length} frame{result.frames?.length === 1 ? '' : 's'},{' '}
        {result.pairs?.toLocaleString()} pixels ·{' '}
        <span className="font-mono tabular-nums">
          {codes(result.before!.p95)} →{' '}
          <span className={result.worthApplying ? 'text-ok-400' : 'text-warn-300'}>{codes(result.after!.p95)}</span>
        </span>{' '}
        code values at the 95th percentile.
      </p>
    ) : (
      <p className={`${PROSE} text-ink-400`}>
        <Check className="inline w-3 h-3 mr-1 text-ok-400 align-[-2px]" aria-hidden="true" />
        Solved exactly
        {result.clippedInput !== undefined && (
          <>
            {' '}· <span className="font-mono tabular-nums">{(result.clippedInput * 100).toFixed(1)}%</span> of the
            range was pinned at black or white in between, and can only be guessed there
          </>
        )}
        .
      </p>
    )}
    {!result.worthApplying && (
      <p className={`${PROSE} text-warn-300`}>
        This table would barely change the picture — the two ends already agree to within a code
        value or two.
      </p>
    )}
    {result.skipped.length > 0 && (
      <p className={`${PROSE} text-ink-500`}>
        Colour only. {list(result.skipped.map(step => step.label))} cannot be described by a table, so
        sharpening and invented detail stay exactly as they are.
      </p>
    )}
  </div>
));

const Failure = memo<{ error: string }>(({ error }) => (
  <p className={`${PROSE} text-bad-300 flex gap-1.5`}>
    <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-px" aria-hidden="true" />
    <span>{error}</span>
  </p>
));

interface LoadLutCardProps {
  filter: Filter;
  filters: Filter[];
  disabled?: boolean;
  job?: LutJob;
  previewOpen: boolean;
  onChoose: (sourceId: string, path: string) => void;
  onPickFile: () => Promise<string | null>;
  onGenerate: () => void;
}

/**
 * Where a Load LUT gets its table: a Create LUT above it, or a file.
 *
 * Only markers above are offered, because a restore reaches back up the
 * chain and nothing else. The one it is already pointed at is shown even
 * when it has moved below or been disabled, so the choice on screen is the
 * choice that was made and the reason it no longer works is beside it.
 */
export const LoadLutCard = memo<LoadLutCardProps>(({
  filter, filters, disabled, job, previewOpen, onChoose, onPickFile, onGenerate,
}) => {
  const link = restoreLink(filters, filter);
  const sourceId = String(filter.parameters?.source_id ?? '');
  const path = String(filter.parameters?.lut_path ?? '');
  const fileName = path ? (path.split(/[\\/]/).pop() ?? path) : '';
  const working = job?.status === 'working';

  const offered = markersAbove(filters, filter);
  const chosenElsewhere = 'marker' in link && !offered.some(marker => marker.id === link.marker.id)
    ? link.marker
    : null;

  const generated = link.state === 'ready' && Boolean(path);
  const stale = generated && String(filter.parameters?.generated_key ?? '') !== ''
    && String(filter.parameters?.generated_key) !== freshFingerprint(filters, filter, link);
  const canGenerate = link.state === 'ready' && link.method.kind !== 'nothing'
    && !(link.method.kind === 'measure' && !previewOpen);

  return (
    <div className={BOX}>
      <span className={HEADING}>Table</span>
      <select
        value={sourceId || (path ? '__file' : '')}
        disabled={disabled || working}
        onChange={async (event) => {
          const chosen = event.target.value;
          if (chosen === '__file') {
            const picked = await onPickFile();
            if (picked) onChoose('', picked);
            return;
          }
          onChoose(chosen, '');
        }}
        className={SELECT}
      >
        <option value="">Nothing chosen</option>
        {(offered.length > 0 || chosenElsewhere) && (
          <optgroup label="From a Create LUT step above">
            {offered.map(marker => (
              <option key={marker.id} value={marker.id}>
                Restore the colour at step {stepNumber(filters, marker.id)}, {markerPlace(filters, marker.id)}
              </option>
            ))}
            {chosenElsewhere && (
              <option value={chosenElsewhere.id}>
                Restore the colour at step {stepNumber(filters, chosenElsewhere.id)}
              </option>
            )}
          </optgroup>
        )}
        {link.state === 'missing' && (
          <option value={sourceId}>A Create LUT step that is no longer in the chain</option>
        )}
        <optgroup label="From a file">
          <option value="__file">A .cube file on disk…</option>
        </optgroup>
      </select>

      {link.state === 'none' && !path && (
        <p className={`${PROSE} text-ink-600`}>
          Point this at a Create LUT above it, or pick a .cube file.
        </p>
      )}
      {link.state === 'none' && path && (
        <p className={`${PROSE} text-ink-500 break-all`}>{fileName}</p>
      )}
      {link.state === 'missing' && (
        <p className={`${PROSE} text-warn-300`}>
          The Create LUT step this was following is gone. Pick another, or a file.
        </p>
      )}
      {link.state === 'disabled' && (
        <p className={`${PROSE} text-warn-300`}>
          Create LUT at step {link.number} is disabled, so there is no colour to put back.
        </p>
      )}
      {link.state === 'below' && (
        <p className={`${PROSE} text-warn-300`}>
          Create LUT at step {link.number} is below this step. A restore can only reach back up the
          chain — move this below it, or pick another.
        </p>
      )}
      {link.state === 'ready' && (
        <>
          {link.method.kind === 'nothing' ? (
            <p className={`${PROSE} text-warn-300`}>
              Nothing sits between this and step {link.number}, so there is nothing to put back.
              Move this below whatever changes the colour.
            </p>
          ) : (
            <Method method={link.method} previewOpen={previewOpen} />
          )}

          {/* A table already made, and whether it still describes the chain
              it came from. Silence here would mean applying yesterday's
              restore without a word. */}
          {generated && stale && (
            <p className={`${PROSE} text-warn-200 flex gap-1.5`}>
              <RefreshCw className="w-3 h-3 flex-shrink-0 mt-px text-warn-400" aria-hidden="true" />
              <span>
                Out of date — the chain between here and step {link.number} has changed since this
                was generated, so the table being applied no longer matches it.
              </span>
            </p>
          )}
          {generated && !stale && job?.status !== 'ready' && (
            <p className={`${PROSE} text-ink-500 break-all`}>
              <Check className="inline w-3 h-3 mr-1 text-ok-400 align-[-2px]" aria-hidden="true" />
              {fileName}
            </p>
          )}

          <div className="flex items-center gap-1.5 pt-0.5">
            <button
              type="button"
              onClick={onGenerate}
              disabled={disabled || working || !canGenerate}
              className={PRIMARY}
              title={link.method.kind === 'measure'
                ? 'Measure the table from frames of the open preview'
                : 'Solve the table from the steps in between'}
            >
              {working ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
              {working
                ? (link.method.kind === 'measure' ? 'Measuring…' : 'Solving…')
                : (generated ? 'Generate again' : 'Generate')}
            </button>
          </div>

          {job?.status === 'ready' && !stale && <Outcome result={job.result} />}
          {job?.status === 'failed' && <Failure error={job.error} />}
        </>
      )}
    </div>
  );
});

/**
 * The fingerprint a restore made right now would carry, for the stale check.
 * Sized from the Load LUT's own setting, the way the generator sizes it.
 */
function freshFingerprint(filters: Filter[], loader: Filter, link: ReturnType<typeof restoreLink>): string {
  if (link.state !== 'ready') return '';
  return restoreFingerprint(filters, link, Number(loader.parameters?.size ?? DEFAULT_LUT_SIZE) || DEFAULT_LUT_SIZE);
}

interface CreateLutCardProps {
  filter: Filter;
  filters: Filter[];
  disabled?: boolean;
  job?: LutJob;
  previewOpen: boolean;
  /** False when there is no Load LUT template to add from. */
  canAddLoader: boolean;
  onAddLoader: () => void;
  onBake: () => void;
}

/**
 * What a Create LUT is, said in the card, because the step itself has no
 * settings and no surface to open. Two things follow from where it sits: a
 * Load LUT below can put this colour back, and the colour work above it can
 * be saved as a file. The second only appears when there is something above.
 *
 * Both were once section headings. Two uppercase headings over two one-line
 * sections read as more structure than there is, so a hairline separates them
 * instead and the buttons name their own actions.
 */
export const CreateLutCard = memo<CreateLutCardProps>(({
  filter, filters, disabled, job, previewOpen, canAddLoader, onAddLoader, onBake,
}) => {
  const place = markerPlace(filters, filter.id);
  const restoredBy = loadersOf(filters, filter.id);
  const span = filter.enabled ? bakeSpan(filters, filter) : null;
  const working = job?.status === 'working';
  const canBake = span !== null && span.method.kind !== 'nothing'
    && !(span.method.kind === 'measure' && !previewOpen);

  return (
    <div className={BOX}>
      <p className={`${PROSE} text-ink-300`}>
        Remembers the colour here, {place}. It changes nothing itself.
      </p>

      <div className="space-y-1">
        <p className={`${PROSE} text-ink-500`}>
          {restoredBy.length > 0
            ? `Put back by Load LUT at step ${list(restoredBy.map(loader => String(stepNumber(filters, loader.id))))}.`
            : 'A Load LUT below whatever changes the colour, pointed here, puts it back.'}
        </p>
        {canAddLoader && (
          <button
            type="button"
            onClick={onAddLoader}
            disabled={disabled}
            className={QUIET}
            title="Adds a Load LUT at the end of the chain, already pointed at this step. Drag it to wherever the colour should come back."
          >
            <Plus className="w-3 h-3" />
            Add a Load LUT
          </button>
        )}
      </div>

      {span !== null && span.method.kind !== 'nothing' && (
        <div className="space-y-1 pt-1.5 border-t border-ink-850">
          <p className={`${PROSE} text-ink-500`}>
            The colour work above this step can also be saved as a .cube, for other footage or
            other software.
          </p>
          <Method method={span.method} previewOpen={previewOpen} />
          <button
            type="button"
            onClick={onBake}
            disabled={disabled || working || !canBake}
            className={PRIMARY}
          >
            {working ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            {working ? (span.method.kind === 'measure' ? 'Measuring…' : 'Baking…') : 'Save .cube…'}
          </button>
          {job?.status === 'ready' && (
            <>
              <Outcome result={job.result} />
              {job.result.savedTo && (
                <p className={`${PROSE} text-ink-500 break-all`}>Written to {job.result.savedTo}</p>
              )}
            </>
          )}
          {job?.status === 'failed' && <Failure error={job.error} />}
        </div>
      )}
    </div>
  );
});
