// src/components/Scrubber.tsx — timeline welded to the bottom of the preview.
//
// Segment selection used to be frame numbers in a card 400px away from the
// picture they described. Here the handles ARE the selection: drag to set in
// and out, the excluded region dims, and the playhead shows where the preview
// frame came from. Frame-exact entry survives in the popover — drag for speed,
// type for precision. See docs/design/README.md.

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Scissors, RotateCcw, Crosshair, Play } from 'lucide-react';
import type { VideoInfo, SegmentSelection } from '../electron.d';

interface ScrubberProps {
  videoInfo: VideoInfo | null;
  segment: SegmentSelection;
  isProcessing: boolean;
  /** Frame the preview is currently showing, if any. */
  playhead: number | null;
  onSegmentChange: (segment: SegmentSelection) => void;
  onSeekFrame?: (frame: number) => void;
  /** Renders a short preview of the selection — carried over from the old panel. */
  onPreviewSegment?: (startFrame: number, endFrame: number) => void;
}

export function frameToTimecode(frame: number, fps: number): string {
  if (!fps || fps <= 0) return '--:--:--';
  const total = frame / fps;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function timecodeToFrame(timecode: string, fps: number): number | null {
  if (!fps || fps <= 0) return null;
  const parts = timecode.split(':').map(p => parseFloat(p));
  if (parts.some(Number.isNaN)) return null;
  let seconds = 0;
  if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
  else if (parts.length === 1) seconds = parts[0];
  else return null;
  return Math.round(seconds * fps);
}

type Handle = 'in' | 'out' | null;

export const Scrubber = memo<ScrubberProps>(({
  videoInfo,
  segment,
  isProcessing,
  playhead,
  onSegmentChange,
  onSeekFrame,
  onPreviewSegment,
}: ScrubberProps) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<Handle>(null);
  const [showPopover, setShowPopover] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  const fps = videoInfo?.fps || 24;
  const totalFrames = videoInfo?.frameCount || 0;
  const hasVideo = totalFrames > 0;

  const inFrame = segment.startFrame;
  const outFrame = segment.endFrame === -1 ? totalFrames : segment.endFrame;

  const pct = useCallback((frame: number) => (
    totalFrames > 0 ? Math.min(100, Math.max(0, (frame / totalFrames) * 100)) : 0
  ), [totalFrames]);

  const frameFromClientX = useCallback((clientX: number) => {
    const el = trackRef.current;
    if (!el || totalFrames <= 0) return 0;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.round(ratio * totalFrames);
  }, [totalFrames]);

  // Drag is tracked on window so the pointer can leave the track mid-gesture.
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const frame = frameFromClientX(e.clientX);
      if (dragging === 'in') {
        onSegmentChange({ ...segment, startFrame: Math.min(frame, outFrame - 1) });
      } else {
        onSegmentChange({ ...segment, endFrame: Math.max(frame, inFrame + 1) });
      }
    };
    const onUp = (e: MouseEvent) => {
      setDragging(null);
      onSeekFrame?.(frameFromClientX(e.clientX));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, frameFromClientX, inFrame, outFrame, segment, onSegmentChange, onSeekFrame]);

  useEffect(() => {
    if (!showPopover) return;
    const onClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setShowPopover(false);
    };
    const onEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowPopover(false); };
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onEscape);
    };
  }, [showPopover]);

  const handleTrackClick = (e: React.MouseEvent) => {
    if (!hasVideo || isProcessing) return;
    onSeekFrame?.(frameFromClientX(e.clientX));
  };

  const toggleSegment = () => {
    const enabling = !segment.enabled;
    onSegmentChange({
      ...segment,
      enabled: enabling,
      // Opening on a full-length selection would make the handles invisible.
      endFrame: segment.endFrame === -1 && totalFrames > 0 ? totalFrames : segment.endFrame,
    });
    if (enabling) setShowPopover(true);
  };

  const setFromPlayhead = (which: 'in' | 'out') => {
    if (playhead == null) return;
    if (which === 'in') onSegmentChange({ ...segment, startFrame: Math.min(playhead, outFrame - 1) });
    else onSegmentChange({ ...segment, endFrame: Math.max(playhead, inFrame + 1) });
  };

  const commitField = (which: 'in' | 'out', raw: string) => {
    const parsed = raw.includes(':') ? timecodeToFrame(raw, fps) : parseInt(raw, 10);
    if (parsed == null || Number.isNaN(parsed)) return;
    const clamped = Math.max(0, Math.min(parsed, totalFrames || parsed));
    if (which === 'in') onSegmentChange({ ...segment, startFrame: Math.min(clamped, outFrame - 1) });
    else onSegmentChange({ ...segment, endFrame: Math.max(clamped, inFrame + 1) });
  };

  const HANDLE = 'absolute top-0 bottom-0 w-[3px] bg-accent-500 cursor-ew-resize hover:w-[5px] transition-[width] z-10';
  const selectedFrames = outFrame - inFrame;

  return (
    <div className="h-10 flex-shrink-0 flex items-center gap-2.5 px-3 bg-ink-900 border-t border-ink-800 relative">
      <span className="text-[11px] font-mono tabular-nums text-ink-500 flex-shrink-0 w-[52px]">
        {segment.enabled ? frameToTimecode(inFrame, fps) : '00:00:00'}
      </span>

      <div
        ref={trackRef}
        onClick={handleTrackClick}
        className={`flex-1 h-[18px] relative rounded overflow-hidden bg-ink-850 border border-ink-800 ${
          hasVideo && !isProcessing ? 'cursor-pointer' : 'opacity-50'
        }`}
        role="slider"
        aria-label="Timeline"
        aria-valuemin={0}
        aria-valuemax={totalFrames}
        aria-valuenow={playhead ?? 0}
      >
        <div
          className="absolute inset-0 opacity-50"
          style={{ backgroundImage: 'repeating-linear-gradient(90deg, currentColor 0 1px, transparent 1px 26px)', color: 'rgb(var(--ink-750))' }}
        />

        {segment.enabled && hasVideo && (
          <>
            <div className="absolute top-0 bottom-0 left-0 bg-ink-950/70" style={{ width: `${pct(inFrame)}%` }} />
            <div className="absolute top-0 bottom-0 right-0 bg-ink-950/70" style={{ width: `${100 - pct(outFrame)}%` }} />
            <div
              className="absolute top-0 bottom-0 bg-accent-500/20"
              style={{ left: `${pct(inFrame)}%`, width: `${pct(outFrame) - pct(inFrame)}%` }}
            />
            <div
              className={HANDLE}
              style={{ left: `${pct(inFrame)}%` }}
              onMouseDown={(e) => { e.stopPropagation(); if (!isProcessing) setDragging('in'); }}
              title={`In — frame ${inFrame}`}
            />
            <div
              className={HANDLE}
              style={{ left: `calc(${pct(outFrame)}% - 3px)` }}
              onMouseDown={(e) => { e.stopPropagation(); if (!isProcessing) setDragging('out'); }}
              title={`Out — frame ${outFrame}`}
            />
          </>
        )}

        {playhead != null && hasVideo && (
          <div
            className="absolute -top-0.5 -bottom-0.5 w-[2px] bg-ink-100 z-20 pointer-events-none"
            style={{ left: `${pct(playhead)}%` }}
            title={`Preview frame ${playhead}`}
          />
        )}
      </div>

      <span className="text-[11px] font-mono tabular-nums text-ink-500 flex-shrink-0 w-[52px] text-right">
        {frameToTimecode(segment.enabled ? outFrame : totalFrames, fps)}
      </span>

      <div className="relative flex-shrink-0" ref={popoverRef}>
        <button
          onClick={segment.enabled ? () => setShowPopover(v => !v) : toggleSegment}
          disabled={!hasVideo || isProcessing}
          aria-pressed={segment.enabled}
          className={`h-[26px] px-2.5 rounded-md inline-flex items-center gap-2 text-[12px] font-medium border transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 ${
            segment.enabled
              ? 'bg-accent-500/12 border-accent-500/45 text-accent-400'
              : 'bg-ink-850 border-ink-750 text-ink-400 hover:text-ink-200 hover:border-ink-700'
          }`}
          title={segment.enabled ? 'Segment options' : 'Process only part of the video'}
        >
          <Scissors className="w-3.5 h-3.5" />
          Segment
        </button>

        {showPopover && segment.enabled && (
          <div className="absolute bottom-full right-0 mb-2 w-[236px] bg-ink-850 border border-ink-750 rounded-lg shadow-xl shadow-black/50 p-2.5 z-50">
            <div className="flex items-center justify-between mb-2">
              <span className="font-display text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-500">
                Segment · frame exact
              </span>
              <button
                onClick={toggleSegment}
                className="text-[11px] text-ink-500 hover:text-bad-400 transition-colors"
                title="Turn segment selection off"
              >
                Off
              </button>
            </div>

            <div className="flex gap-2">
              {(['in', 'out'] as const).map(which => (
                <label key={which} className="flex-1 min-w-0">
                  <span className="block text-[9px] uppercase tracking-[0.1em] text-ink-500 mb-1">{which}</span>
                  <input
                    type="text"
                    defaultValue={String(which === 'in' ? inFrame : outFrame)}
                    key={`${which}-${which === 'in' ? inFrame : outFrame}`}
                    onBlur={(e) => commitField(which, e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    disabled={isProcessing}
                    className="w-full h-[22px] bg-ink-900 border border-ink-750 rounded px-1.5 text-[11px] font-mono tabular-nums text-ink-200 focus:outline-none focus:border-accent-500 transition-colors disabled:opacity-40"
                    title="Frame number, or a timecode like 00:04:12"
                  />
                </label>
              ))}
            </div>

            {onPreviewSegment && (
              <button
                onClick={() => onPreviewSegment(inFrame, outFrame)}
                disabled={isProcessing}
                className="w-full h-[24px] mt-2 rounded inline-flex items-center justify-center gap-1.5 text-[11px] font-medium bg-ink-800 border border-ink-750 text-ink-300 hover:text-ink-100 hover:border-ink-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                title="Render a short preview of this selection"
              >
                <Play className="w-3 h-3" />
                Preview selection
              </button>
            )}

            <div className="flex items-center gap-2 mt-2 text-[10px] font-mono tabular-nums text-ink-400">
              <span>{selectedFrames.toLocaleString()} frames</span>
              <span>·</span>
              <span>{frameToTimecode(selectedFrames, fps)}</span>
            </div>

            <div className="flex items-center gap-1.5 mt-2 pt-2 border-t border-ink-800">
              <button
                onClick={() => setFromPlayhead('in')}
                disabled={playhead == null}
                className="flex-1 h-[22px] rounded inline-flex items-center justify-center gap-1 text-[10.5px] text-accent-400 hover:bg-accent-500/12 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                title="Set in to the frame the preview is showing"
              >
                <Crosshair className="w-3 h-3" />
                In here
              </button>
              <button
                onClick={() => setFromPlayhead('out')}
                disabled={playhead == null}
                className="flex-1 h-[22px] rounded inline-flex items-center justify-center gap-1 text-[10.5px] text-accent-400 hover:bg-accent-500/12 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                title="Set out to the frame the preview is showing"
              >
                <Crosshair className="w-3 h-3" />
                Out here
              </button>
              <button
                onClick={() => onSegmentChange({ ...segment, startFrame: 0, endFrame: totalFrames || -1 })}
                className="w-[22px] h-[22px] rounded grid place-items-center text-ink-500 hover:text-ink-200 hover:bg-ink-800 transition-colors"
                title="Reset to the whole video"
              >
                <RotateCcw className="w-3 h-3" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
