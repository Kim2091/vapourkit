// src/components/ColorGradeOverlay.tsx — the graded picture, over the cached frame.
//
// The <img> underneath is the frame entering this grade step: the "before".
// This canvas is the same frame with the grade applied, clipped to the wipe
// position, so before and after are the same pixels in the same place and the
// comparison costs one clip-path rather than a second render.
//
// Holding a key snaps to before without moving anything, which is the
// comparison that actually answers "have I gone too far".

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GradeRenderer } from '../utils/gradeRenderer';
import { GRADE_NEUTRAL, type GradeValues } from '../utils/colorGrade';

export type CompareMode = 'wipe' | 'after' | 'split';

interface ColorGradeOverlayProps {
  /** The element showing the ungraded frame; its box is what we cover. */
  imageRef: React.RefObject<HTMLImageElement>;
  frameSize: { width: number; height: number } | null;
  values: GradeValues;
  mode: CompareMode;
  /** True while the "hold for before" key is down. */
  holdingBefore: boolean;
  stepLabel: string;
  onRendererError?: (message: string) => void;
}

/** Where an object-contain image actually sits inside its box. */
function containBox(
  container: { width: number; height: number },
  frame: { width: number; height: number },
) {
  if (!container.width || !container.height || !frame.width || !frame.height) return null;
  const scale = Math.min(container.width / frame.width, container.height / frame.height);
  const width = frame.width * scale;
  const height = frame.height * scale;
  return {
    left: (container.width - width) / 2,
    top: (container.height - height) / 2,
    width,
    height,
  };
}

export const ColorGradeOverlay = memo<ColorGradeOverlayProps>(({
  imageRef,
  frameSize,
  values,
  mode,
  holdingBefore,
  stepLabel,
  onRendererError,
}: ColorGradeOverlayProps) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<GradeRenderer | null>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [wipe, setWipe] = useState(0.5);
  const [failed, setFailed] = useState(false);

  // Measured off the <img> itself rather than trusting the parent's state.
  // That state is reset in an effect keyed on the frame, which can land after
  // a data: URL has already fired `load` — leaving the size null forever and
  // the canvas at 0x0, which looks exactly like "the grade does nothing".
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const sourceSize = naturalSize ?? frameSize;

  const box = useMemo(
    () => containBox(bounds, sourceSize ?? { width: 0, height: 0 }),
    [bounds, sourceSize],
  );

  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const update = () => setBounds({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // One renderer per mounted overlay, rebuilt if the driver takes the context
  // away. `generation` is what lets a restore rebuild it.
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

  // Read the grade through a ref here: an upload only has to happen when the
  // picture changes, and depending on values would re-register the load
  // listener on every frame of a trackball drag.
  const latest = useRef({ values, holdingBefore });
  latest.current = { values, holdingBefore };

  const uploadFrame = useCallback(() => {
    const image = imageRef.current;
    if (!image || !image.naturalWidth) return;
    // Record the size even if the renderer is not up yet, so the layout box
    // can be solved independently of whether WebGL came back.
    setNaturalSize(previous =>
      previous?.width === image.naturalWidth && previous?.height === image.naturalHeight
        ? previous
        : { width: image.naturalWidth, height: image.naturalHeight });
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setFrame(image, image.naturalWidth, image.naturalHeight);
    renderer.render(latest.current.holdingBefore ? GRADE_NEUTRAL : latest.current.values);
  }, [imageRef]);

  useEffect(() => {
    const image = imageRef.current;
    if (!image) return;
    if (image.complete && image.naturalWidth) {
      uploadFrame();
      return;
    }
    image.addEventListener('load', uploadFrame);
    return () => image.removeEventListener('load', uploadFrame);
    // `generation` re-uploads the texture after a context restore, which
    // starts the new context with no frame in it.
  }, [imageRef, uploadFrame, frameSize, generation]);

  useEffect(() => {
    rendererRef.current?.render(holdingBefore ? GRADE_NEUTRAL : values);
  }, [values, holdingBefore]);

  const onWipeDown = (event: React.MouseEvent) => {
    if (mode !== 'wipe' || !box) return;
    event.preventDefault();
    const move = (pointer: { clientX: number }) => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = pointer.clientX - rect.left - box.left;
      setWipe(Math.min(1, Math.max(0, x / box.width)));
    };
    move(event);
    const onMove = (native: MouseEvent) => move(native);
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // The graded canvas covers the picture from the divider rightwards, so
  // before is on the left and after on the right — which is what the stamps
  // say. "after" pulls the divider to the left edge; holding pushes it off
  // the right, leaving the untouched <img> showing through.
  const hidden = holdingBefore ? 1 : mode === 'wipe' ? wipe : 0;

  // The canvas is mounted unconditionally. Returning early before it exists
  // left canvasRef null on the one pass the renderer effect runs, so the
  // renderer was never built and the picture never graded.
  return (
    <div ref={rootRef} className="absolute inset-0" onMouseDown={onWipeDown}>
      <div
        className="absolute overflow-hidden"
        style={{
          left: box?.left ?? 0,
          top: box?.top ?? 0,
          width: box?.width ?? 0,
          height: box?.height ?? 0,
          visibility: box ? 'visible' : 'hidden',
          clipPath: `inset(0 0 0 ${hidden * 100}%)`,
        }}
      >
        <canvas
          ref={canvasRef}
          className="block rounded-lg"
          style={{ width: box?.width ?? 0, height: box?.height ?? 0 }}
        />
      </div>

      {/* A grade that cannot draw used to look exactly like a grade that does
          nothing. Say which stage is missing instead of failing silently. */}
      {!failed && !box && (
        <div className="absolute inset-x-0 top-2 flex justify-center pointer-events-none">
          <span className="px-2 py-1 rounded bg-ink-950/90 border border-warn-500/40 text-[11px] text-warn-400">
            Grading preview waiting on the frame size
          </span>
        </div>
      )}

      {failed && (
        <div className="absolute inset-x-0 top-2 flex justify-center pointer-events-none">
          <span className="px-2 py-1 rounded bg-ink-950/90 border border-warn-500/40 text-[11px] text-warn-400">
            WebGL unavailable — the dock still edits values, but the preview is not graded
          </span>
        </div>
      )}

      {box && mode === 'wipe' && !holdingBefore && (
        <span
          aria-hidden="true"
          className="absolute w-px bg-white/85 cursor-ew-resize"
          style={{ left: box.left + box.width * wipe, top: box.top, height: box.height }}
        >
          <span className="absolute top-1/2 left-1/2 w-4 h-4 -mt-2 -ml-2 rounded-full border border-white bg-ink-950/40" />
        </span>
      )}

      {box && (
        <>
          {hidden > 0.02 && (
            <span className="absolute font-display text-[10px] font-semibold uppercase tracking-[0.09em] px-1.5 py-0.5 rounded bg-ink-950/85 text-ink-300 pointer-events-none"
              style={{ left: box.left + 6, bottom: bounds.height - box.top - box.height + 6 }}>
              {holdingBefore ? 'Before' : `Before · ${stepLabel}`}
            </span>
          )}
          {hidden < 0.98 && (
            <span className="absolute font-display text-[10px] font-semibold uppercase tracking-[0.09em] px-1.5 py-0.5 rounded bg-ink-950/85 text-accent-300 pointer-events-none"
              style={{ right: bounds.width - box.left - box.width + 6, bottom: bounds.height - box.top - box.height + 6 }}>
              After · this grade
            </span>
          )}
        </>
      )}
    </div>
  );
});
