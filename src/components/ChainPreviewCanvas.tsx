// src/components/ChainPreviewCanvas.tsx — the selected step's real pixels.
//
// Frames arrive from the preview session as packed RGB24 and go straight into
// a texture. There is no <img>, no data URL and no intermediate canvas: the
// bytes VapourSynth produced are the bytes uploaded.
//
// It reuses GradeRenderer rather than adding a second WebGL context. Browsers
// cap how many exist at once, and the grading overlay already owns one.

import { memo, useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { GradeRenderer } from '../utils/gradeRenderer';
import { GRADE_NEUTRAL, type GradeValues } from '../utils/colorGrade';
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
  onRendererError?: (message: string) => void;
}

export const ChainPreviewCanvas = memo<ChainPreviewCanvasProps>(({
  frame,
  gradeValues = null,
  holdingBefore = false,
  onRendererError,
}: ChainPreviewCanvasProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<GradeRenderer | null>(null);
  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);

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

  // Draw whenever the frame or the grade changes. With no grade step open this
  // is one neutral pass, which is the step exactly as it renders.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !frame) return;
    renderer.render(holdingBefore || !gradeValues ? GRADE_NEUTRAL : gradeValues);
  }, [frame, gradeValues, holdingBefore, generation]);

  if (failed) {
    return (
      <div className="flex flex-col items-center gap-2 text-center text-ink-500">
        <AlertTriangle className="w-7 h-7 text-warn-500" />
        <p className="text-[12.5px]">The preview needs WebGL, which is unavailable.</p>
      </div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      className="rounded-lg shadow-lg"
      style={{ width: '100%', height: '100%', objectFit: 'contain' }}
    />
  );
});
