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

export interface UseChainPreviewResult {
  isOpen: boolean;
  isOpening: boolean;
  isRendering: boolean;
  /** True when the chain changed under an open session, so it must reload. */
  isStale: boolean;
  steps: ChainPreviewStep[];
  selected: number;
  frame: ChainPreviewFrame | null;
  error: string | null;
  open: () => Promise<void>;
  /** Stops an open in flight. Safe to call when nothing is opening. */
  cancel: () => Promise<void>;
  close: () => Promise<void>;
  select: (index: number) => void;
  seek: (n: number) => void;
}

/** The basename of a model path, without its extension. */
function modelLabel(modelPath: string): string {
  const base = modelPath.split(/[\\/]/).pop() ?? modelPath;
  return base.replace(/\.(onnx|engine)$/i, '');
}

/**
 * Names the steps the generator will emit, in the same order it emits them:
 * output 0 is the source, then one per enabled filter by ascending order.
 */
function stepLabels(filters: Filter[]): string[] {
  const enabled = filters.filter(f => f.enabled).sort((a, b) => a.order - b.order);
  return [
    'Source',
    ...enabled.map(filter =>
      filter.filterType === 'aiModel' && filter.modelPath
        ? modelLabel(filter.modelPath)
        : filter.preset || 'Custom filter',
    ),
  ];
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
  const [frame, setFrame] = useState<ChainPreviewFrame | null>(null);
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
    error,
    open,
    cancel,
    close,
    select,
    seek,
  };
}
