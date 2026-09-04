import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import type { CropFilterEditor, FilterParameterValues } from '../electron.d';

interface CropValues {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

type DragMode = 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

interface DragState {
  mode: DragMode;
  origin: CropValues;
  startX: number;
  startY: number;
}

interface CropEditorOverlayProps {
  editor: CropFilterEditor;
  parameters?: FilterParameterValues;
  sourceSize: { width: number; height: number } | null;
  disabled?: boolean;
  onCommit: (parameters: FilterParameterValues) => void;
  onClose: () => void;
}

const clamp = (value: number, minimum: number, maximum: number) => Math.min(Math.max(value, minimum), maximum);

function cropFromParameters(
  editor: CropFilterEditor,
  parameters: FilterParameterValues | undefined,
  sourceSize: { width: number; height: number } | null,
): CropValues {
  const maximumWidth = Math.max(0, (sourceSize?.width ?? 1) - 1);
  const maximumHeight = Math.max(0, (sourceSize?.height ?? 1) - 1);
  const getValue = (name: keyof CropFilterEditor['variables'], maximum: number) => {
    const value = parameters?.[editor.variables[name]];
    return typeof value === 'number' && Number.isFinite(value) ? clamp(Math.round(value), 0, maximum) : 0;
  };

  let left = getValue('left', maximumWidth);
  let right = getValue('right', maximumWidth);
  let top = getValue('top', maximumHeight);
  let bottom = getValue('bottom', maximumHeight);

  // Keep a non-empty selection if a malformed imported configuration tries to
  // crop away the entire source frame.
  if (left + right >= (sourceSize?.width ?? 1)) right = Math.max(0, maximumWidth - left);
  if (top + bottom >= (sourceSize?.height ?? 1)) bottom = Math.max(0, maximumHeight - top);
  return { left, right, top, bottom };
}

function cropToParameters(editor: CropFilterEditor, crop: CropValues, parameters?: FilterParameterValues): FilterParameterValues {
  return {
    ...parameters,
    [editor.variables.left]: crop.left,
    [editor.variables.right]: crop.right,
    [editor.variables.top]: crop.top,
    [editor.variables.bottom]: crop.bottom,
  };
}

/**
 * The crop editor is rendered over the exact object-contain image area, not
 * its letterbox. It stores crop amounts in source pixels so the result remains
 * correct at any preview size or display scale.
 */
export function CropEditorOverlay({
  editor,
  parameters,
  sourceSize,
  disabled = false,
  onCommit,
  onClose,
}: CropEditorOverlayProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [crop, setCrop] = useState<CropValues>(() => cropFromParameters(editor, parameters, sourceSize));

  const syncCrop = useCallback(() => setCrop(cropFromParameters(editor, parameters, sourceSize)), [editor, parameters, sourceSize]);

  useEffect(() => {
    syncCrop();
  }, [syncCrop]);

  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const updateBounds = () => setBounds({ width: element.clientWidth, height: element.clientHeight });
    updateBounds();
    const observer = new ResizeObserver(updateBounds);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const imageBounds = useMemo(() => {
    if (!sourceSize || bounds.width <= 0 || bounds.height <= 0) return null;
    const scale = Math.min(bounds.width / sourceSize.width, bounds.height / sourceSize.height);
    const width = sourceSize.width * scale;
    const height = sourceSize.height * scale;
    return {
      x: (bounds.width - width) / 2,
      y: (bounds.height - height) / 2,
      width,
      height,
      scale,
    };
  }, [bounds, sourceSize]);

  const clampCrop = useCallback((next: CropValues): CropValues => {
    if (!sourceSize) return next;
    const left = clamp(Math.round(next.left), 0, sourceSize.width - 1);
    const right = clamp(Math.round(next.right), 0, sourceSize.width - 1 - left);
    const top = clamp(Math.round(next.top), 0, sourceSize.height - 1);
    const bottom = clamp(Math.round(next.bottom), 0, sourceSize.height - 1 - top);
    return { left, right, top, bottom };
  }, [sourceSize]);

  const pointFromEvent = useCallback((event: React.PointerEvent) => {
    const root = rootRef.current;
    if (!root || !imageBounds || !sourceSize) return null;
    const rect = root.getBoundingClientRect();
    return {
      x: clamp(Math.round((event.clientX - rect.left - imageBounds.x) / imageBounds.scale), 0, sourceSize.width),
      y: clamp(Math.round((event.clientY - rect.top - imageBounds.y) / imageBounds.scale), 0, sourceSize.height),
    };
  }, [imageBounds, sourceSize]);

  const updateFromPointer = useCallback((event: React.PointerEvent): CropValues | null => {
    const drag = dragRef.current;
    const point = pointFromEvent(event);
    if (!drag || !point || !sourceSize) return null;

    const rightEdge = sourceSize.width - drag.origin.right;
    const bottomEdge = sourceSize.height - drag.origin.bottom;
    let next = { ...drag.origin };

    if (drag.mode === 'move') {
      const deltaX = point.x - drag.startX;
      const deltaY = point.y - drag.startY;
      const selectionWidth = sourceSize.width - drag.origin.left - drag.origin.right;
      const selectionHeight = sourceSize.height - drag.origin.top - drag.origin.bottom;
      next.left = clamp(drag.origin.left + deltaX, 0, sourceSize.width - selectionWidth);
      next.right = sourceSize.width - selectionWidth - next.left;
      next.top = clamp(drag.origin.top + deltaY, 0, sourceSize.height - selectionHeight);
      next.bottom = sourceSize.height - selectionHeight - next.top;
    } else {
      if (drag.mode.includes('w')) next.left = clamp(point.x, 0, rightEdge - 1);
      if (drag.mode.includes('e')) next.right = clamp(sourceSize.width - point.x, 0, sourceSize.width - drag.origin.left - 1);
      if (drag.mode.includes('n')) next.top = clamp(point.y, 0, bottomEdge - 1);
      if (drag.mode.includes('s')) next.bottom = clamp(sourceSize.height - point.y, 0, sourceSize.height - drag.origin.top - 1);
    }

    return clampCrop(next);
  }, [clampCrop, pointFromEvent, sourceSize]);

  const startDrag = useCallback((event: React.PointerEvent, mode: DragMode) => {
    if (disabled) return;
    const point = pointFromEvent(event);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { mode, origin: crop, startX: point.x, startY: point.y };
  }, [crop, disabled, pointFromEvent]);

  const moveDrag = useCallback((event: React.PointerEvent) => {
    if (!dragRef.current) return;
    const next = updateFromPointer(event);
    if (next) setCrop(next);
  }, [updateFromPointer]);

  const endDrag = useCallback((event: React.PointerEvent) => {
    if (!dragRef.current) return;
    const next = updateFromPointer(event) ?? crop;
    dragRef.current = null;
    setCrop(next);
    onCommit(cropToParameters(editor, next, parameters));
  }, [crop, editor, onCommit, parameters, updateFromPointer]);

  if (!sourceSize) return null;

  const selection = imageBounds ? {
    left: imageBounds.x + crop.left * imageBounds.scale,
    top: imageBounds.y + crop.top * imageBounds.scale,
    width: Math.max(1, sourceSize.width - crop.left - crop.right) * imageBounds.scale,
    height: Math.max(1, sourceSize.height - crop.top - crop.bottom) * imageBounds.scale,
  } : null;
  const outputWidth = sourceSize.width - crop.left - crop.right;
  const outputHeight = sourceSize.height - crop.top - crop.bottom;
  const handles: { mode: DragMode; className: string; cursor: string }[] = [
    { mode: 'nw', className: '-left-1.5 -top-1.5', cursor: 'nwse-resize' },
    { mode: 'ne', className: '-right-1.5 -top-1.5', cursor: 'nesw-resize' },
    { mode: 'sw', className: '-bottom-1.5 -left-1.5', cursor: 'nesw-resize' },
    { mode: 'se', className: '-bottom-1.5 -right-1.5', cursor: 'nwse-resize' },
    { mode: 'n', className: 'left-1/2 -top-1.5 -translate-x-1/2', cursor: 'ns-resize' },
    { mode: 's', className: '-bottom-1.5 left-1/2 -translate-x-1/2', cursor: 'ns-resize' },
    { mode: 'w', className: '-left-1.5 top-1/2 -translate-y-1/2', cursor: 'ew-resize' },
    { mode: 'e', className: '-right-1.5 top-1/2 -translate-y-1/2', cursor: 'ew-resize' },
  ];

  return (
    <div ref={rootRef} className="absolute inset-0 overflow-hidden touch-none select-none" aria-label="Crop selection editor">
      <button
        type="button"
        onClick={onClose}
        className="absolute right-3 top-3 z-10 inline-flex h-7 items-center gap-1.5 rounded border border-accent-500/60 bg-accent-500 px-2.5 text-[11px] font-semibold text-accent-ink shadow-lg transition-colors hover:bg-accent-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
        title="Apply crop and close editor (Esc)"
      >
        <Check className="h-3.5 w-3.5" />
        Done
      </button>
      {selection && (
        <>
          <div
            className="absolute border-2 border-accent-400 bg-accent-500/5 shadow-[0_0_0_9999px_rgba(0,0,0,0.58)]"
            style={selection}
            onPointerDown={(event) => startDrag(event, 'move')}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            title="Drag to reposition the crop"
          >
            <span className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white whitespace-nowrap">
              {outputWidth} x {outputHeight}
            </span>
            {handles.map(handle => (
              <button
                key={handle.mode}
                type="button"
                aria-label={`Resize crop from the ${handle.mode} edge`}
                className={`absolute h-3 w-3 rounded-sm border border-white bg-accent-500 shadow-sm ${handle.className}`}
                style={{ cursor: handle.cursor }}
                onPointerDown={(event) => startDrag(event, handle.mode)}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              />
            ))}
          </div>
          <div className="pointer-events-none absolute left-3 top-3 rounded bg-black/75 px-2 py-1 text-[10px] tabular-nums text-ink-100 shadow">
            L {crop.left} / R {crop.right} / T {crop.top} / B {crop.bottom}
          </div>
        </>
      )}
    </div>
  );
}
