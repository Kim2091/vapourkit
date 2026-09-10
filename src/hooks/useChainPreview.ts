// src/hooks/useChainPreview.ts — the in-app preview of the filter chain.
//
// Holds one warm VapourSynth session while the preview is open. The session
// exposes the chain as numbered outputs — 0 is the untouched source, then one
// per enabled filter — so selecting a step is choosing an output rather than
// re-running anything, and VapourSynth shares the upstream work between them.
//
// Labels come from the filter list here rather than from the script. The app
// built the chain, so it already knows what each step is called.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BackendId,
  Filter,
  PreviewLevels,
  PreviewOutput,
  PreviewSourceProps,
  SegmentSelection,
  VideoInfo,
} from '../electron.d';

export interface ChainPreviewStep extends PreviewOutput {
  /** What to call this step in the rail. */
  label: string;
}

export interface ChainPreviewFrame {
  pixels: Uint8Array;
  width: number;
  height: number;
  n: number;
  output: number;
  /** Where the picture sits, per channel and in luma, in 8-bit code values. */
  levels: PreviewLevels | null;
  /** How the clip feeding this step is tagged. */
  source: PreviewSourceProps | null;
}

interface UseChainPreviewOptions {
  videoInfo: VideoInfo | null;
  filters: Filter[];
  selectedModel: string | null;
  defaultBackend: BackendId;
  numStreams: number;
  segment: SegmentSelection;
  /** Width to render at. The session downscales; it never upscales. */
  previewWidth: number;
  /**
   * The filter whose values are being dragged right now, if any.
   *
   * Its parameters are left out of the chain key. A grade is applied to the
   * picture by the shader while the session sits on the step below it, so the
   * frames the session is serving do not depend on those values — and treating
   * every trackball delta as a chain change would make grading a reload loop.
   * The moment the editor closes it rejoins the key, so a changed grade does
   * ask for the reload that makes it real.
   */
  liveParameterFilterId?: string | null;
  onError?: (message: string) => void;
}

/** One frame number, as the two steps of a pair render it. */
export interface StepSample {
  n: number;
  /** The step being corrected. */
  from: ChainPreviewFrame;
  /** The step being matched to. */
  to: ChainPreviewFrame;
}

export interface UseChainPreviewResult {
  isOpen: boolean;
  isOpening: boolean;
  isRendering: boolean;
  /** True when the chain changed under an open session, so it must reload. */
  isStale: boolean;
  steps: ChainPreviewStep[];
  selected: number;
  frame: ChainPreviewFrame | null;
  /**
   * The output pinned as the "before" side of a split, or null for the
   * selected step's own picture — which is the classic before/after.
   *
   * Pinning another step turns the comparison from "what did this grade do"
   * into "does this match that", which is the one you want when you are
   * grading a step to sit alongside the source rather than to look good on
   * its own.
   */
  reference: number | null;
  /** That step's frame, at the same frame number. */
  referenceFrame: ChainPreviewFrame | null;
  setReference: (index: number | null) => void;
  /**
   * The same frames as two steps render them, for measuring the colour
   * between them.
   *
   * Both sides come back at the same requested width, which is what makes the
   * pixels comparable at all: the session downscales every output to it, so a
   * 2x model's picture and the source arrive on the same grid and pixel n is
   * the same part of the picture in both. Rejects rather than guesses if the
   * two are shaped differently, which is what a crop between them looks like.
   */
  samplePair: (correctedIndex: number, targetIndex: number, frameNumbers: number[]) => Promise<StepSample[]>;
  error: string | null;
  open: () => Promise<void>;
  /** Stops an open in flight. Safe to call when nothing is opening. */
  cancel: () => Promise<void>;
  close: () => Promise<void>;
  select: (index: number) => void;
  seek: (n: number) => void;
}

/** Cache key for a reference picture: which output, and which frame of it. */
const referenceKey = (output: number, n: number) => `${output}:${n}`;

/** The basename of a model path, without its extension. */
function modelLabel(modelPath: string): string {
  const base = modelPath.split(/[\\/]/).pop() ?? modelPath;
  return base.replace(/\.(onnx|engine)$/i, '');
}

/**
 * What one step is called, wherever it sits.
 *
 * Split out of stepLabels because a step can need naming while it is disabled
 * — a reference pointed at a step that has since been turned off has to say
 * which step that was — and stepLabels only indexes the enabled ones.
 */
export function stepLabel(filter: Filter): string {
  return filter.filterType === 'aiModel' && filter.modelPath
    ? modelLabel(filter.modelPath)
    : filter.preset || 'Custom filter';
}

/**
 * Names the steps the generator will emit, in the same order it emits them:
 * output 0 is the source, then one per enabled filter by ascending order.
 *
 * Exported because the numbering is not the preview's private business: a
 * Load LUT names the Create LUT it puts back by the step that marker sits
 * before, and it has to be able to do that with no session open — the labels
 * have to agree either way.
 */
export function stepLabels(filters: Filter[]): string[] {
  const enabled = filters.filter(f => f.enabled).sort((a, b) => a.order - b.order);
  return ['Source', ...enabled.map(stepLabel)];
}

/**
 * Everything that changes which pixels a step produces. When this changes, the
 * open session is describing a chain that no longer exists — and worse, the
 * output indices may have moved, so step 3's picture could appear under step
 * 4's label. vs-view answers the same problem with Ctrl+R; so does this.
 */
function chainKey(options: UseChainPreviewOptions, liveParameters: string | null): string {
  const enabled = options.filters
    .filter(f => f.enabled)
    .sort((a, b) => a.order - b.order)
    .map(f => ({
      t: f.filterType,
      p: f.preset,
      c: f.code,
      m: f.modelPath,
      b: f.backend,
      s: f.numStreams,
      // The open editor contributes the values it had when it opened, frozen,
      // so dragging does not move the key — and neither does opening, which
      // would otherwise retire a session the instant a saved grade was
      // opened for editing.
      v: f.id === options.liveParameterFilterId && liveParameters !== null
        ? liveParameters
        : JSON.stringify(f.parameters ?? null),
    }));

  return JSON.stringify({
    video: options.videoInfo?.path,
    model: options.selectedModel,
    backend: options.defaultBackend,
    streams: options.numStreams,
    segment: options.segment,
    filters: enabled,
  });
}

export function useChainPreview(options: UseChainPreviewOptions): UseChainPreviewResult {
  const { videoInfo, filters, previewWidth, onError } = options;

  const [isOpen, setIsOpen] = useState(false);
  const [isOpening, setIsOpening] = useState(false);
  const [isRendering, setIsRendering] = useState(false);
  const [isStale, setIsStale] = useState(false);
  const [outputs, setOutputs] = useState<PreviewOutput[]>([]);
  const [selected, setSelected] = useState(0);
  /** For callbacks that must not be rebuilt every time the step changes. */
  const selectedRef = useRef(0);
  selectedRef.current = selected;
  const [frame, setFrame] = useState<ChainPreviewFrame | null>(null);
  const [reference, setReferenceState] = useState<number | null>(null);
  const [referenceFrame, setReferenceFrame] = useState<ChainPreviewFrame | null>(null);
  /** Read inside pump, which must not be rebuilt on every reference change. */
  const referenceRef = useRef<number | null>(null);
  referenceRef.current = reference;
  /** What referenceFrame currently holds, so a re-seek is not a re-fetch. */
  const referenceHeld = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // One request in flight, one pending, newest wins. A seek fires far faster
  // than a chain renders, and the last one asked for is the only one worth
  // painting.
  const inFlight = useRef(false);
  const queued = useRef<{ n: number; index: number } | null>(null);
  const playhead = useRef(0);

  // Snapshot of the open editor's parameters, held for as long as it is open.
  const frozenLive = useRef<{ id: string; json: string } | null>(null);
  const liveId = options.liveParameterFilterId ?? null;
  if (liveId === null) {
    frozenLive.current = null;
  } else if (frozenLive.current?.id !== liveId) {
    const target = options.filters.find(f => f.id === liveId);
    frozenLive.current = { id: liveId, json: JSON.stringify(target?.parameters ?? null) };
  }

  const key = chainKey(options, frozenLive.current?.json ?? null);
  const openKey = useRef<string | null>(null);
  // An open can sit in a preflight for minutes, so a cancel usually lands
  // while one is still running. This is what stops the abandoned open from
  // reporting success over the top of it.
  const openToken = useRef(0);

  const labels = useMemo(() => stepLabels(filters), [filters]);

  const steps = useMemo<ChainPreviewStep[]>(
    () => outputs.map(output => ({
      ...output,
      label: labels[output.index] ?? `Step ${output.index}`,
    })),
    [outputs, labels],
  );

  const fail = useCallback((message: string) => {
    setError(message);
    onError?.(message);
  }, [onError]);

  const pump = useCallback(async () => {
    if (inFlight.current) return;
    const next = queued.current;
    if (!next) return;
    queued.current = null;
    inFlight.current = true;
    setIsRendering(true);

    try {
      const result = await window.electronAPI.previewFrame(next.n, previewWidth);
      if (result.success && result.data) {
        setFrame({
          pixels: result.data,
          width: result.width!,
          height: result.height!,
          n: result.n!,
          output: result.output!,
          levels: result.levels ?? null,
          source: result.source ?? null,
        });
        setError(null);
      } else if (result.error) {
        fail(result.error);
      }

      // The reference, after the picture the user is actually working on, so
      // it fills in behind rather than delaying it. It is fetched by borrowing
      // the session's selection and putting it straight back — the session
      // renders whichever output is selected, and there is only one of it.
      //
      // Cached on (output, frame): the reference cannot change while a grade
      // is dragged, because the grade is a shader and the session is not
      // re-rendering anything. So this costs two round trips on a seek and
      // nothing at all on the path that matters.
      const ref = referenceRef.current;
      const wanted = ref === null || ref === next.index ? null : referenceKey(ref, next.n);
      if (wanted === null) {
        referenceHeld.current = null;
        setReferenceFrame(null);
      } else if (referenceHeld.current !== wanted) {
        const picked = await window.electronAPI.previewSelect(ref!);
        if (picked.success) {
          const refResult = await window.electronAPI.previewFrame(next.n, previewWidth);
          if (refResult.success && refResult.data) {
            referenceHeld.current = wanted;
            setReferenceFrame({
              pixels: refResult.data,
              width: refResult.width!,
              height: refResult.height!,
              n: refResult.n!,
              output: refResult.output!,
              levels: refResult.levels ?? null,
              source: refResult.source ?? null,
            });
          }
        }
        // Put the selection back whatever happened, or every later frame
        // would come from the reference step.
        await window.electronAPI.previewSelect(next.index);
      }
    } catch (caught) {
      fail(caught instanceof Error ? caught.message : String(caught));
    } finally {
      inFlight.current = false;
      setIsRendering(false);
      if (queued.current) void pump();
    }
  }, [previewWidth, fail]);

  const request = useCallback((n: number, index: number) => {
    playhead.current = n;
    queued.current = { n, index };
    void pump();
  }, [pump]);

  const open = useCallback(async () => {
    if (!videoInfo || isOpening) return;
    const token = ++openToken.current;
    setIsOpening(true);
    setError(null);

    try {
      const result = await window.electronAPI.previewOpen(
        videoInfo.path,
        options.selectedModel,
        options.defaultBackend,
        true,
        filters,
        options.numStreams,
        options.segment,
      );

      if (token !== openToken.current) return;

      if (!result.success || !result.outputs) {
        // A cancel is not a failure; it does not belong in the console.
        if (!result.cancelled) fail(result.error ?? 'Could not open the preview session');
        return;
      }

      const last = result.outputs[result.outputs.length - 1];
      setOutputs(result.outputs);
      setSelected(last.index);
      setIsOpen(true);
      setIsStale(false);
      openKey.current = key;

      await window.electronAPI.previewSelect(last.index);
      request(playhead.current, last.index);
    } catch (caught) {
      if (token === openToken.current) {
        fail(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (token === openToken.current) setIsOpening(false);
    }
    // `key` is read for the staleness marker, not to re-run this callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoInfo, filters, options.selectedModel, options.defaultBackend,
      options.numStreams, options.segment, isOpening, fail, request, key]);

  const cancel = useCallback(async () => {
    openToken.current++;
    queued.current = null;
    setIsOpening(false);
    setError(null);
    try {
      await window.electronAPI.previewCancel();
    } catch {
      // Nothing to stop, or it is already stopping.
    }
  }, []);

  const close = useCallback(async () => {
    openToken.current++;
    queued.current = null;
    setIsOpen(false);
    setIsStale(false);
    setOutputs([]);
    setFrame(null);
    setReferenceState(null);
    setReferenceFrame(null);
    referenceHeld.current = null;
    setError(null);
    openKey.current = null;
    try {
      await window.electronAPI.previewClose();
    } catch {
      // The session is going away regardless.
    }
  }, []);

  const select = useCallback((index: number) => {
    if (!isOpen) return;
    setSelected(index);
    void window.electronAPI
      .previewSelect(index)
      .then(result => {
        if (!result.success) {
          fail(result.error ?? 'Could not select that step');
          return;
        }
        request(playhead.current, index);
      })
      .catch(caught => fail(caught instanceof Error ? caught.message : String(caught)));
  }, [isOpen, request, fail]);

  /**
   * Take the session over for a moment.
   *
   * There is one session and it renders whichever output is selected, so
   * sampling a pair has to borrow it — the same borrow the reference fetch
   * makes, held for longer. Waiting rather than barging matters: a frame
   * arriving for the wrong output would be painted as the step on screen.
   */
  const claimSession = useCallback(async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 200 && inFlight.current; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (inFlight.current) return false;
    inFlight.current = true;
    return true;
  }, []);

  const samplePair = useCallback(async (
    correctedIndex: number,
    targetIndex: number,
    frameNumbers: number[],
  ): Promise<StepSample[]> => {
    if (!isOpen) throw new Error('The preview is not open, so there is nothing to measure.');
    if (correctedIndex === targetIndex) throw new Error('Those are the same step.');

    // A queued seek is about to be overtaken anyway, and letting it run after
    // the borrow would repaint from whichever output was selected last.
    queued.current = null;
    if (!await claimSession()) {
      throw new Error('The preview is still rendering. Try again in a moment.');
    }
    setIsRendering(true);

    const grab = async (index: number, n: number): Promise<ChainPreviewFrame> => {
      const picked = await window.electronAPI.previewSelect(index);
      if (!picked.success) throw new Error(picked.error ?? `Could not select step ${index}`);
      const result = await window.electronAPI.previewFrame(n, previewWidth);
      if (!result.success || !result.data) {
        throw new Error(result.error ?? `Could not render frame ${n} of step ${index}`);
      }
      return {
        pixels: result.data,
        width: result.width!,
        height: result.height!,
        n: result.n!,
        output: result.output!,
        levels: result.levels ?? null,
        source: result.source ?? null,
      };
    };

    try {
      const samples: StepSample[] = [];
      for (const n of frameNumbers) {
        const from = await grab(correctedIndex, n);
        const to = await grab(targetIndex, n);
        if (from.width !== to.width || from.height !== to.height) {
          throw new Error(
            `Those two steps are ${from.width}×${from.height} and ${to.width}×${to.height} at the same width, `
            + 'so their pixels do not line up — something between them crops or changes the shape of the picture.',
          );
        }
        samples.push({ n, from, to });
      }
      return samples;
    } finally {
      // Put the selection back whatever happened, or every later frame would
      // come from whichever step was sampled last.
      await window.electronAPI.previewSelect(selectedRef.current).catch(() => {});
      inFlight.current = false;
      setIsRendering(false);
      if (queued.current) void pump();
    }
  }, [isOpen, claimSession, previewWidth, pump]);

  const setReference = useCallback((index: number | null) => {
    setReferenceState(index);
    if (index === null) {
      referenceHeld.current = null;
      setReferenceFrame(null);
      return;
    }
    // The held key belongs to the old reference, so drop it and ask again for
    // the frame already on screen.
    referenceHeld.current = null;
    if (isOpen) request(playhead.current, selectedRef.current);
  }, [isOpen, request]);

  const seek = useCallback((n: number) => {
    playhead.current = n;
    if (isOpen) request(n, selected);
  }, [isOpen, request, selected]);

  // The chain moved under an open session. Stop rather than keep serving
  // frames from a script that no longer describes the filter list.
  useEffect(() => {
    if (!isOpen || openKey.current === null || openKey.current === key) return;
    setIsStale(true);
    queued.current = null;
    void window.electronAPI.previewClose().catch(() => {});
  }, [key, isOpen]);

  // A session holds a decoder and its cache. Never leave one behind.
  useEffect(() => () => {
    void window.electronAPI.previewClose().catch(() => {});
  }, []);

  return {
    isOpen,
    isOpening,
    isRendering,
    isStale,
    steps,
    selected,
    frame,
    reference,
    referenceFrame,
    setReference,
    samplePair,
    error,
    open,
    cancel,
    close,
    select,
    seek,
  };
}
