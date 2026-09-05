// src/components/ChainPreviewCanvas.tsx — the selected step's real pixels.
//
// Frames arrive from the preview session as packed RGB24 and go straight into
// a texture. There is no <img>, no data URL and no intermediate canvas: the
// bytes VapourSynth produced are the bytes uploaded.
//
// It reuses GradeRenderer rather than adding a second WebGL context. Browsers
// cap how many exist at once, and the grading overlay already owns one.

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { GradeRenderer } from '../utils/gradeRenderer';
import { GRADE_NEUTRAL, type GradeValues } from '../utils/colorGrade';
import { containBox, type CompareMode } from './ColorGradeOverlay';
import type { ChainPreviewFrame } from '../hooks/useChainPreview';

interface ChainPreviewCanvasProps {
  frame: ChainPreviewFrame | null;
  /**
   * Live grade to shade the frame with, when a grade step is open.
   *
   * The session is parked on the step below the grade, so this texture is the
   * picture entering it — and the shader is generated from the same model as
   * the emitted Python, so shading it here is the grade, not an impression of
   * one. That is what makes a trackball drag cost a draw call instead of a
   * script reload.
   */
  gradeValues?: GradeValues | null;
  /** True while the hold-for-before key is down. */
  holdingBefore?: boolean;
  /** Wipe compares across the frame; after shows the graded picture in full. */
  mode?: CompareMode;
  stepLabel?: string;
  onRendererError?: (message: string) => void;
}

export const ChainPreviewCanvas = memo<ChainPreviewCanvasProps>(({
  frame,
  gradeValues = null,
  holdingBefore = false,
  mode = 'after',
  stepLabel = '',
  onRendererError,
}: ChainPreviewCanvasProps) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<GradeRenderer | null>(null);
  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [wipe, setWipe] = useState(0.5);

  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const update = () => setBounds({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Without preventDefault the browser never fires webglcontextrestored, so
    // a recoverable driver reset would strand the preview permanently.
    const onLost = (event: Event) => {
      event.preventDefault();
      rendererRef.current = null;
      setFailed(true);
    };
    const onRestored = () => setGeneration(value => value + 1);
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);

    try {
      rendererRef.current = new GradeRenderer(canvas);
      setFailed(false);
    } catch (error) {
      setFailed(true);
      onRendererError?.(error instanceof Error ? error.message : String(error));
    }

    return () => {
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, [onRendererError, generation]);

  // Upload only when the frame itself changes. A drag fires far faster than
  // frames arrive, and re-uploading a texture per trackball delta would spend
  // the whole budget moving bytes that did not change.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !frame) return;
    renderer.setFrameBuffer(frame.pixels, frame.width, frame.height);
  }, [frame, generation]);

  // How much of the width shows the ungraded frame. Holding pushes it to the
  // whole picture; "after" pulls it off entirely.
  const before = !gradeValues ? 1 : holdingBefore ? 1 : mode === 'wipe' ? wipe : 0;

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !frame) return;
    renderer.renderWipe(gradeValues ?? GRADE_NEUTRAL, before);
  }, [frame, gradeValues, before, generation]);

  const box = containBox(bounds, frame ? { width: frame.width, height: frame.height } : { width: 0, height: 0 });

  const onWipeDown = useCallback((event: React.MouseEvent) => {
    if (mode !== 'wipe' || !gradeValues || !box) return;
    event.preventDefault();
    const move = (clientX: number) => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      setWipe(Math.min(1, Math.max(0, (clientX - rect.left - box.left) / box.width)));
    };
    move(event.clientX);
    const onMove = (native: MouseEvent) => move(native.clientX);
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [mode, gradeValues, box]);

  if (failed) {
    return (
      <div className="flex flex-col items-center gap-2 text-center text-ink-500">
        <AlertTriangle className="w-7 h-7 text-warn-500" />
        <p className="text-[12.5px]">The preview needs WebGL, which is unavailable.</p>
      </div>
    );
  }

  const showDivider = Boolean(box) && mode === 'wipe' && Boolean(gradeValues) && !holdingBefore;

  return (
    <div ref={rootRef} className="absolute inset-0" onMouseDown={onWipeDown}>
      <canvas
        ref={canvasRef}
        className="absolute block rounded-lg shadow-lg"
        style={{
          left: box?.left ?? 0,
          top: box?.top ?? 0,
          width: box?.width ?? 0,
          height: box?.height ?? 0,
          visibility: box ? 'visible' : 'hidden',
        }}
      />

      {showDivider && box && (
        <span
          aria-hidden="true"
          className="absolute w-px bg-white/85 cursor-ew-resize"
          style={{ left: box.left + box.width * wipe, top: box.top, height: box.height }}
        >
          <span className="absolute top-1/2 left-1/2 w-4 h-4 -mt-2 -ml-2 rounded-full border border-white bg-ink-950/40" />
        </span>
      )}

      {box && gradeValues && (
        <>
          {before > 0.02 && (
            <span
              className="absolute font-display text-[10px] font-semibold uppercase tracking-[0.09em] px-1.5 py-0.5 rounded bg-ink-950/85 text-ink-300 pointer-events-none"
              style={{ left: box.left + 6, bottom: bounds.height - box.top - box.height + 6 }}
            >
              {holdingBefore || !stepLabel ? 'Before' : `Before · ${stepLabel}`}
            </span>
          )}
          {before < 0.98 && (
            <span
              className="absolute font-display text-[10px] font-semibold uppercase tracking-[0.09em] px-1.5 py-0.5 rounded bg-ink-950/85 text-accent-300 pointer-events-none"
              style={{ right: bounds.width - box.left - box.width + 6, bottom: bounds.height - box.top - box.height + 6 }}
            >
              After · this grade
            </span>
          )}
        </>
      )}
    </div>
  );
});
