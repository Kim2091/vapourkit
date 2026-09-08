// src/hooks/useLutSteps.ts — generating the tables the chain's LUT steps need.
//
// Two jobs, both read off the chain by utils/lutSteps and neither asking a
// question first:
//
//   restore(loadId)  A Load LUT pointed at a Create LUT above it. Build the
//                    table that turns the picture arriving at the Load LUT back
//                    into the colour the Create LUT saw, write it beside the
//                    app's data, and point the step at it.
//
//   bake(markerId)   A Create LUT. Everything the chain does to colour above
//                    it, written to a file the person picks. Never a step in
//                    the chain, only a file to take elsewhere.
//
// Which engine answers is not a preference to offer:
//
//   Everything in the span modelled → solve it. Compose the transform forwards
//   and, for a restore, invert the composition. Exact, and needs no frames.
//
//   Anything else in the way — a neural model, a sharpener, a filter with no
//   colour model → measure it. There is no function to invert, so sample the
//   same frames at both ends and fit the mapping to what is actually there.
//   That needs the preview open, because the frames come from it.
//
// Both say which they were before the table is written, and what they
// achieved after.

import { useCallback, useMemo, useState } from 'react';
import { notify } from '../utils/notifications';
import { getErrorMessage } from '../types/errors';
import { planBetween, pendingLutPaths, splitPlan } from '../utils/chainLut';
import {
  bakeChainToLut, writeCube, writeLut, DEFAULT_LUT_SIZE,
  type Lut, type LutFormat, type SkippedStep,
} from '../utils/lut';
import { invertOperations } from '../utils/lutInvert';
import {
  pairsFromFrames, concatPairs, fitMatch, matchIsWorthApplying,
  type ResidualSummary,
} from '../utils/colorMatch';
import { bakeSpan, markerPlace, restoreFingerprint, restoreLink } from '../utils/lutSteps';
import type { Filter, SegmentSelection, VideoInfo } from '../electron.d';
import type { StepSample } from './useChainPreview';

export interface LutResult {
  method: 'solve' | 'measure';
  /** How much of the range the modelled transform pinned. Solve only. */
  clippedInput?: number;
  /** What the fit was measured to achieve. Measure only. */
  before?: ResidualSummary;
  after?: ResidualSummary;
  pairs?: number;
  frames?: number[];
  /** Steps the table could not describe, named for the user. */
  skipped: SkippedStep[];
  /** False when the table would not earn its place in the chain. */
  worthApplying: boolean;
  /** Where a baked file went. Bake only. */
  savedTo?: string;
}

/** One step's generation, as the card beside it shows it. */
export type LutJob =
  | { status: 'working' }
  | { status: 'ready'; result: LutResult }
  | { status: 'failed'; error: string };

interface UseLutStepsOptions {
  filters: Filter[];
  setFilters: (filters: Filter[]) => void;
  videoInfo: VideoInfo | null;
  segment: SegmentSelection;
  playheadFrame: number | null;
  currentWorkflow: string | null;
  samplePair: (from: number, to: number, frames: number[]) => Promise<StepSample[]>;
  previewOpen: boolean;
  addConsoleLog: (line: string) => void;
}

/** Frames to measure from. Odd, so the playhead's own frame is the middle. */
export const FRAME_COUNTS = [1, 3, 5, 9] as const;

const percent = (fraction: number) => `${(fraction * 100).toFixed(fraction < 0.01 ? 2 : 1)}%`;
const fileSafe = (name: string) => name.replace(/[\\/:*?"<>|]/g, '_');

const sizeOf = (filter: Filter) => Number(filter.parameters?.size ?? DEFAULT_LUT_SIZE) || DEFAULT_LUT_SIZE;
const framesOf = (filter: Filter) => Number(filter.parameters?.frames ?? 5) || 5;

export function useLutSteps(options: UseLutStepsOptions) {
  const {
    filters, setFilters, videoInfo, segment, playheadFrame,
    currentWorkflow, samplePair, previewOpen, addConsoleLog,
  } = options;

  const [jobs, setJobs] = useState<Record<string, LutJob>>({});
  const setJob = useCallback((id: string, job: LutJob | null) => {
    setJobs(current => {
      const next = { ...current };
      if (job) next[id] = job;
      else delete next[id];
      return next;
    });
  }, []);

  /**
   * Which frames to measure, spread across whatever is being worked on.
   *
   * The playhead's frame is always one of them — it is the picture on screen,
   * and a fit that disagreed with what someone was looking at would be very
   * hard to trust. The rest spread evenly over the segment, because five
   * frames of one dark shot is a table that only knows about dark shots.
   */
  const pickFrames = useCallback((count: number): number[] => {
    const total = videoInfo?.frameCount ?? 0;
    const last = Math.max(0, total - 1);
    const start = segment.enabled ? Math.max(0, segment.startFrame) : 0;
    const end = segment.enabled && segment.endFrame >= 0 ? Math.min(last, segment.endFrame) : last;
    const at = Math.min(Math.max(playheadFrame ?? start, start), Math.max(start, end));
    if (count <= 1 || end <= start) return [at];

    const picks = new Set<number>([at]);
    for (let i = 0; i < count - 1; i++) {
      const spread = start + Math.round(((i + 0.5) / (count - 1)) * (end - start));
      picks.add(Math.min(end, Math.max(start, spread)));
    }
    return [...picks].sort((a, b) => a - b).slice(0, count);
  }, [videoInfo, segment, playheadFrame]);

  /**
   * Resolve a span's plan, reading any table it needs off disk first.
   *
   * The first plan is made with no tables so it can say which paths it
   * wants; only then are those read, and only those. A plan that read every
   * LUT in the chain would be reading files for steps outside the span.
   */
  const resolvePlan = useCallback(async (low: number, high: number) => {
    let plan = planBetween(filters, low, high, new Map());
    const wanted = pendingLutPaths(plan);
    if (wanted.length > 0) {
      const tables = new Map<string, string>();
      for (const path of wanted) {
        const read = await window.electronAPI.readLutFile(path);
        if (read.success) tables.set(path, read.text);
      }
      plan = planBetween(filters, low, high, tables);
    }
    return splitPlan(plan);
  }, [filters]);

  /**
   * Measure the transform from one output to another off real frames.
   *
   * The two shared failures — no preview, no flat colour to read — are said
   * here, once, in the words the person can act on.
   */
  const measure = useCallback(async (
    from: number, to: number, count: number, size: number, title: string, blocker: SkippedStep | undefined,
  ) => {
    if (!previewOpen) {
      throw new Error(
        `${blocker?.label ?? 'A step'} in the way cannot be evaluated, so this table has to be `
        + 'measured from real frames — open the preview first.',
      );
    }
    const picked = pickFrames(count);
    const samples = await samplePair(from, to, picked);
    const pairs = concatPairs(samples.map(sample => pairsFromFrames(
      sample.from.pixels, sample.to.pixels, sample.from.width, sample.from.height,
    )));
    if (pairs.count === 0) {
      throw new Error(
        'Every pixel in those frames sits on detail rather than on flat colour, so there is '
        + 'nothing to measure. Try a frame with more even areas in it.',
      );
    }
    const fit = fitMatch(pairs, size, `${title} (measured from ${picked.length} frames)`);
    return { fit, picked };
  }, [previewOpen, pickFrames, samplePair]);

  /**
   * Make the table a Load LUT step is asking for, and point the step at it.
   *
   * The path is what the render actually reads — a step id means nothing to
   * VapourSynth — so the table is installed beside the app's data and the
   * step's path and fingerprint are written in one update, so no render can
   * catch a new fingerprint over an old file.
   */
  const restore = useCallback(async (loadId: string) => {
    const loader = filters.find(filter => filter.id === loadId);
    if (!loader) return;
    const link = restoreLink(filters, loader);
    if (link.state !== 'ready' || link.method.kind === 'nothing') return;

    setJob(loadId, { status: 'working' });
    try {
      const size = sizeOf(loader);
      const name = `Restore ${link.place}`;
      const title = `${currentWorkflow || 'Vapourkit'} — ${name}`;
      const { operations, skipped } = await resolvePlan(link.to, link.from);
      let lut: Lut;
      let made: LutResult;

      if (skipped.length === 0 && operations.length > 0) {
        // The steps between are what took the colour away, so the restore
        // is their composition run backwards.
        const solved = invertOperations(operations, size, `${title} (exact)`);
        lut = solved.lut;
        made = { method: 'solve', clippedInput: solved.clippedInput, skipped: [], worthApplying: true };
        addConsoleLog(
          `Load LUT — "${name}" solved exactly back through ${operations.map(o => o.label).join(' → ')};`
          + ` ${percent(solved.clippedInput)} of the range was pinned in between.`,
        );
      } else {
        const { fit, picked } = await measure(link.from, link.to, framesOf(loader), size, title, skipped[0]);
        lut = fit.lut;
        made = {
          method: 'measure',
          before: fit.before,
          after: fit.after,
          pairs: fit.pairs,
          frames: picked,
          skipped,
          worthApplying: matchIsWorthApplying(fit),
        };
        addConsoleLog(
          `Load LUT — "${name}" measured over ${picked.length} frame(s), ${fit.pairs} pixels:`
          + ` ${fit.before.p95.toFixed(1)} → ${fit.after.p95.toFixed(1)} code values at the 95th.`,
        );
      }

      const installed = await window.electronAPI.installLut(fileSafe(name), writeCube(lut, lut.title));
      if (!installed.success) throw new Error(installed.error);

      const key = restoreFingerprint(filters, link, size);
      setFilters(filters.map(item => item.id === loadId
        ? { ...item, parameters: { ...item.parameters, lut_path: installed.path, generated_key: key } }
        : item));
      setJob(loadId, { status: 'ready', result: made });
    } catch (caught) {
      setJob(loadId, { status: 'failed', error: getErrorMessage(caught) });
    }
  }, [filters, currentWorkflow, resolvePlan, measure, setFilters, addConsoleLog, setJob]);

  /**
   * Save what the chain does to colour above a Create LUT as a file.
   *
   * The save dialog comes first when the answer is exact, because that costs
   * nothing to compute and a cancelled dialog should cost nothing either.
   * When it has to be measured the preview check comes before the dialog,
   * so nobody names a file for a table that was never going to be made.
   */
  const bake = useCallback(async (markerId: string) => {
    const marker = filters.find(filter => filter.id === markerId);
    if (!marker) return;
    const span = bakeSpan(filters, marker);
    if (!span || span.method.kind === 'nothing') return;
    if (span.method.kind === 'measure' && !previewOpen) {
      notify.warning(
        'Open the preview first',
        `${span.method.because.label} cannot be evaluated, so this table has to be measured from frames.`,
      );
      return;
    }

    const name = `Colour ${markerPlace(filters, markerId)}`;
    const path = await window.electronAPI.selectLutFile('save', `${fileSafe(name)}.cube`);
    if (!path) return;

    setJob(markerId, { status: 'working' });
    try {
      const size = sizeOf(marker);
      const title = `${currentWorkflow || 'Vapourkit'} — ${name}`;
      const { operations, skipped } = await resolvePlan(0, span.to);
      let lut: Lut;
      let made: LutResult;

      if (skipped.length === 0 && operations.length > 0) {
        lut = bakeChainToLut(operations, [], size, title).lut;
        made = { method: 'solve', skipped: [], worthApplying: true, savedTo: path };
      } else {
        const { fit, picked } = await measure(0, span.to, framesOf(marker), size, title, skipped[0]);
        lut = fit.lut;
        made = {
          method: 'measure',
          before: fit.before,
          after: fit.after,
          pairs: fit.pairs,
          frames: picked,
          skipped,
          worthApplying: matchIsWorthApplying(fit),
          savedTo: path,
        };
      }

      const format: LutFormat = path.toLowerCase().endsWith('.3dl') ? '3dl' : 'cube';
      const written = await window.electronAPI.writeLutFile(path, writeLut(lut, format, lut.title));
      if (!written.success) throw new Error(written.error);

      notify.success('LUT saved', `${size}×${size}×${size} .${format} written.`);
      addConsoleLog(`Create LUT — "${name}" written to ${path}${made.method === 'measure' ? ' (measured)' : ''}.`);
      setJob(markerId, { status: 'ready', result: made });
    } catch (caught) {
      setJob(markerId, { status: 'failed', error: getErrorMessage(caught) });
    }
  }, [filters, previewOpen, currentWorkflow, resolvePlan, measure, addConsoleLog, setJob]);

  const clear = useCallback((id: string) => setJob(id, null), [setJob]);

  return useMemo(() => ({ jobs, restore, bake, clear }), [jobs, restore, bake, clear]);
}

export type LutStepActions = ReturnType<typeof useLutSteps>;
