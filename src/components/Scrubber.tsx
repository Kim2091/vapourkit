// src/components/Scrubber.tsx — timeline welded to the bottom of the preview.
//
// Segment selection used to be frame numbers in a card 400px away from the
// picture they described. Here the handles ARE the selection: drag to set in
// and out, the excluded region dims, and the playhead shows where the preview
// frame came from. Frame-exact entry survives in the popover — drag for speed,
// type for precision.

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Scissors, RotateCcw, Crosshair, Play, Pause, Loader2, Repeat, ChevronDown } from 'lucide-react';
import type { VideoInfo, SegmentSelection } from '../electron.d';

interface ScrubberProps {
  videoInfo: VideoInfo | null;
  segment: SegmentSelection;
  isProcessing: boolean;
  /** Frame the preview is currently showing, if any. */
  playhead: number | null;
  onSegmentChange: (segment: SegmentSelection) => void;
  onSeekFrame?: (frame: number) => void;
  /**
   * Transport for the chain preview, when one is open.
   *
   * It belongs here rather than on the step rail: this is the timeline, and
   * play is a statement about the timeline. The rail says which picture.
   */
  playback?: {
    isPlaying: boolean;
    /** The session is still opening — pressing play is what started it. */
    isOpening: boolean;
    targetFps: number;
    achievedFps: number | null;
    behind: boolean;
    onToggle: () => void;
    /** Stop, without the toggle's ambiguity — frame stepping needs a stop. */
    onPause: () => void;
    loop: boolean;
    onLoopChange: (loop: boolean) => void;
  } | null;
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

/** Stands in for a position no video has been loaded to have yet. */
const BLANK_TIMECODE = '--:--:--';

const clampFrame = (frame: number, low: number, high: number) =>
  Math.max(low, Math.min(high, Math.round(frame)));

/** 'scrub' is the playhead itself being dragged along the track. */
type Handle = 'in' | 'out' | 'scrub' | null;

/** Nothing selected means the arrows move the playhead. */
export type Focus = 'in' | 'out' | null;

export interface StepOutcome {
  /** Where the playhead lands. Always set: a step you cannot see is no use. */
  seek: number;
  /** The moved segment, when a handle had the arrows. */
  segment?: SegmentSelection;
}

/**
 * The span the playhead may move over: the segment when one is set, the whole
 * clip otherwise.
 *
 * Home and End are about the thing you are working on, and once a segment is
 * set that is the segment — jumping to frame 0 of a 24-minute episode when
 * you are cutting a 30-second range is never what was meant.
 */
export function playbackBounds(
  segment: SegmentSelection,
  totalFrames: number,
): { first: number; last: number } {
  if (!segment.enabled) return { first: 0, last: Math.max(0, totalFrames - 1) };
  const out = segment.endFrame === -1 ? totalFrames : segment.endFrame;
  return {
    first: Math.max(0, Math.min(segment.startFrame, totalFrames)),
    last: Math.max(0, Math.min(out, totalFrames) - 1),
  };
}

/**
 * What one arrow press does.
 *
 * Separated from the component because it is all the decisions and none of
 * the DOM: which thing the arrows own, where it may go, and what the playhead
 * does about it. A handle step also seeks, so the frame you just chose as the
 * boundary is the frame you are looking at.
 */
export function stepFrame(
  delta: number,
  focus: Focus,
  segment: SegmentSelection,
  playhead: number | null,
  totalFrames: number,
): StepOutcome {
  const inFrame = segment.startFrame;
  const outFrame = segment.endFrame === -1 ? totalFrames : segment.endFrame;
  const active = segment.enabled ? focus : null;

  if (active === 'in') {
    // Never past the out point, and never off the front.
    const next = clampFrame(inFrame + delta, 0, Math.max(0, Math.min(outFrame - 1, totalFrames)));
    return { seek: next, segment: { ...segment, startFrame: next } };
  }
  if (active === 'out') {
    const next = clampFrame(outFrame + delta, Math.min(inFrame + 1, totalFrames), totalFrames);
    return { seek: next, segment: { ...segment, endFrame: next } };
  }
  return { seek: clampFrame((playhead ?? 0) + delta, 0, totalFrames) };
}

export const Scrubber = memo<ScrubberProps>(({
  videoInfo,
  segment,
  isProcessing,
  playhead,
  onSegmentChange,
  onSeekFrame,
  playback = null,
}: ScrubberProps) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<Handle>(null);
  /**
   * Which handle the arrow keys move. Click one to take it; click the track
   * to give it back to the playhead.
   */
  const [focused, setFocused] = useState<Focus>(null);
  /** Read inside the key handler, which must not be rebuilt per frame. */
  const playbackRef = useRef(playback);
  playbackRef.current = playback;
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
      if (dragging === 'scrub') {
        // Seeks are coalesced downstream — one render in flight, newest wins —
        // so a fast drag costs the frames it can actually show, not one per
        // pixel of travel.
        onSeekFrame?.(frame);
      } else if (dragging === 'in') {
        const next = Math.min(frame, outFrame - 1);
        onSegmentChange({ ...segment, startFrame: next });
        // The picture follows the handle, so you are choosing an in point by
        // looking at the frame it lands on rather than at a number.
        onSeekFrame?.(next);
      } else {
        const next = Math.max(frame, inFrame + 1);
        onSegmentChange({ ...segment, endFrame: next });
        onSeekFrame?.(next);
      }
    };
    const onUp = () => {
      // Deliberately no seek. Dragging a handle is setting the segment, and
      // moving the playhead to wherever the drag happened to end made every
      // handle adjustment jump the picture somewhere you did not ask for.
      setDragging(null);
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

  /**
   * Move whatever the arrows currently own by one frame.
   *
   * Stepping is a paused activity: nudging a frame while the chain is playing
   * would show it for the length of one frame and then run away from it, so
   * the transport stops first.
   */
  const step = useCallback((delta: number) => {
    if (!hasVideo || isProcessing) return;
    // Stepping is a paused activity: nudging one frame while the chain plays
    // would show it for a frame and then run away from it.
    if (playbackRef.current?.isPlaying) playbackRef.current.onPause();

    const outcome = stepFrame(delta, focused, segment, playhead, totalFrames);
    if (outcome.segment) onSegmentChange(outcome.segment);
    onSeekFrame?.(outcome.seek);
  }, [hasVideo, isProcessing, focused, segment, playhead, totalFrames,
      onSegmentChange, onSeekFrame]);

  /** Jump to an end of whatever is in play — the segment, or the whole clip. */
  const jump = useCallback((to: 'first' | 'last') => {
    if (!hasVideo || isProcessing) return;
    if (playbackRef.current?.isPlaying) playbackRef.current.onPause();
    setFocused(null);
    onSeekFrame?.(playbackBounds(segment, totalFrames)[to]);
  }, [hasVideo, isProcessing, segment, totalFrames, onSeekFrame]);

  // Space and the arrows are taken globally, because they are about the
  // picture rather than about whatever happens to hold focus. Three guards:
  //
  // defaultPrevented covers every control that already claims these keys —
  // the grade sliders and the trackball both nudge on arrows, and React's
  // handlers run at the root before this listener sees the event at window,
  // so a key they took arrives here already spoken for.
  //
  // The tag check is still needed on top: a text field moves its caret by
  // default rather than by preventing anything, so nothing marks that event.
  // And a focused button already fires its own click on Space.
  const onToggle = playback?.onToggle;
  const stepRef = useRef(step);
  stepRef.current = step;
  const jumpRef = useRef(jump);
  jumpRef.current = jump;
  const fpsRef = useRef(fps);
  fpsRef.current = fps;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (target?.isContentEditable) return;

      if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        e.preventDefault();
        // Shift steps a second at a time. One frame is the right grain for
        // finding a cut; it is a useless grain for crossing an episode.
        const grain = e.shiftKey ? Math.max(1, Math.round(fpsRef.current)) : 1;
        stepRef.current(e.code === 'ArrowRight' ? grain : -grain);
        return;
      }
      if (e.code === 'Home' || e.code === 'End') {
        e.preventDefault();
        jumpRef.current(e.code === 'Home' ? 'first' : 'last');
        return;
      }
      if (e.code === 'Space' && !e.repeat && tag !== 'BUTTON') {
        if (!onToggle) return;
        e.preventDefault();
        onToggle();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onToggle]);

  const handleTrackMouseDown = (e: React.MouseEvent) => {
    if (!hasVideo || isProcessing || e.button !== 0) return;
    // Scrubbing against a running chain fights it for the session and reads as
    // stutter, so the transport stops the moment you take hold of the track.
    if (playbackRef.current?.isPlaying) playbackRef.current.onPause();
    // The track is about the playhead, so it hands the arrows back.
    setFocused(null);
    onSeekFrame?.(frameFromClientX(e.clientX));
    setDragging('scrub');
  };

  const toggleSegment = () => {
    const enabling = !segment.enabled;
    onSegmentChange({
      ...segment,
      enabled: enabling,
      // Opening on a full-length selection would make the handles invisible.
      endFrame: segment.endFrame === -1 && totalFrames > 0 ? totalFrames : segment.endFrame,
    });
    if (enabling) {
      setShowPopover(true);
    } else {
      setShowPopover(false);
      setFocused(null);
    }
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
  // The handle the arrows are pointed at. Widened rather than recoloured, so
  // it reads as the same handle with the keyboard on it.
  const HANDLE_FOCUSED = 'w-[5px] shadow-[0_0_0_1px_rgb(var(--ink-950)),0_0_6px_rgb(var(--accent-500))]';
  const selectedFrames = outFrame - inFrame;
  const draggingHandle = dragging === 'in' || dragging === 'out';

  return (
    <div className="h-10 flex-shrink-0 flex items-center gap-2.5 px-3 bg-ink-900 border-t border-ink-800 relative">
      {playback && (
        <button
          onClick={playback.onToggle}
          disabled={!hasVideo || isProcessing || playback.isOpening}
          className="w-[26px] h-[26px] flex-shrink-0 rounded-md grid place-items-center border border-ink-750 bg-ink-850 text-ink-300 hover:text-ink-100 hover:border-ink-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
          title={playback.isOpening
            ? 'Starting the preview session…'
            : playback.isPlaying
              ? 'Pause — or press Space'
              : 'Play — or press Space'}
          aria-label={playback.isPlaying ? 'Pause' : 'Play'}
          aria-pressed={playback.isPlaying}
        >
          {playback.isOpening
            ? <Loader2 className="w-3.5 h-3.5 animate-spin text-accent-500" />
            : playback.isPlaying
              ? <Pause className="w-3.5 h-3.5" />
              : <Play className="w-3.5 h-3.5" />}
        </button>
      )}

      {/* Where you are. The bar could say where the segment starts and how
          long the file is and still leave you unable to answer "where am I",
          which is the question every other control here is in service of. */}
      <span
        className="flex-shrink-0 inline-flex items-baseline gap-1.5 font-mono tabular-nums"
        title={hasVideo
          ? `Frame ${(playhead ?? 0).toLocaleString()} of ${totalFrames.toLocaleString()}`
          : 'Nothing loaded yet'}
      >
        <span className={`text-[11px] w-[52px] ${hasVideo ? 'text-ink-200' : 'text-ink-700'}`}>
          {hasVideo ? frameToTimecode(playhead ?? 0, fps) : BLANK_TIMECODE}
        </span>
        {/* Sized to the widest value this clip can reach — measured on the
            formatted string, so the thousands separators are counted — and
            right-aligned, so it neither jitters as the count grows nor leaves
            a hole beside a single-digit frame. */}
        {hasVideo && (
          <span
            className="text-[10px] text-ink-600 text-right"
            style={{ width: `${totalFrames.toLocaleString().length}ch` }}
          >
            {(playhead ?? 0).toLocaleString()}
          </span>
        )}
      </span>

      <div
        ref={trackRef}
        onMouseDown={handleTrackMouseDown}
        className={`flex-1 h-[18px] relative rounded overflow-hidden bg-ink-850 border border-ink-800 ${
          !hasVideo || isProcessing
            ? 'opacity-50'
            : dragging === 'scrub' ? 'cursor-grabbing' : 'cursor-pointer'
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
            {(['in', 'out'] as const).map(which => {
              const frame = which === 'in' ? inFrame : outFrame;
              return (
                <div
                  key={which}
                  className={`${HANDLE} ${focused === which ? HANDLE_FOCUSED : ''}`}
                  style={which === 'in'
                    ? { left: `${pct(frame)}%` }
                    : { left: `calc(${pct(frame)}% - 3px)` }}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    if (isProcessing) return;
                    // Taken on press, so the arrows follow the handle you are
                    // about to drag as well as the one you only clicked.
                    if (playbackRef.current?.isPlaying) playbackRef.current.onPause();
                    setFocused(which);
                    setDragging(which);
                  }}
                  title={`${which === 'in' ? 'In' : 'Out'} — frame ${frame}. `
                    + 'Click to step it with the arrow keys'}
                />
              );
            })}
          </>
        )}

        {/* Hidden while a handle is being dragged: the picture is showing that
            handle's frame, so the handle already marks where the playhead is,
            and a second line under it reads as two positions. */}
        {playhead != null && hasVideo && !draggingHandle && (
          <div
            className="absolute -top-0.5 -bottom-0.5 w-[2px] bg-ink-100 z-20 pointer-events-none"
            style={{ left: `${pct(playhead)}%` }}
            title={`Preview frame ${playhead}`}
          />
        )}
      </div>

      <span className={`text-[11px] font-mono tabular-nums flex-shrink-0 w-[52px] text-right ${
        hasVideo ? 'text-ink-500' : 'text-ink-700'
      }`}>
        {hasVideo ? frameToTimecode(segment.enabled ? outFrame : totalFrames, fps) : BLANK_TIMECODE}
      </span>

      {playback && (
        <button
          onClick={() => playback.onLoopChange(!playback.loop)}
          disabled={!hasVideo || isProcessing}
          aria-pressed={playback.loop}
          className={`w-[26px] h-[26px] flex-shrink-0 rounded-md grid place-items-center border transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 ${
            playback.loop
              ? 'bg-accent-500/12 border-accent-500/45 text-accent-400'
              : 'bg-ink-850 border-ink-750 text-ink-500 hover:text-ink-200 hover:border-ink-700'
          }`}
          title={segment.enabled
            ? 'Run the segment round again at the out point'
            : 'Run the clip round again at the end'}
        >
          <Repeat className="w-3.5 h-3.5" />
        </button>
      )}

      {playback?.isPlaying && playback.targetFps > 0 && (
        <span
          className={`text-[11px] font-mono tabular-nums flex-shrink-0 ${
            playback.behind ? 'text-warn-400' : 'text-ink-500'
          }`}
          title={playback.behind
            ? 'The chain is rendering slower than this step plays. Every frame is still shown, in order — the clock is what slipped, not the picture.'
            : 'Playing at the rate this step runs at'}
        >
          {playback.behind && playback.achievedFps !== null
            ? `${playback.achievedFps.toFixed(1)} / ${playback.targetFps.toFixed(2)}`
            : playback.targetFps.toFixed(2)}
        </span>
      )}

      <div className="relative flex-shrink-0" ref={popoverRef}>
        {/* Split, because these are two different questions. The label is
            whether the segment applies at all — the thing you need to be able
            to take back — and the chevron is what its numbers are. Folding
            both into one button left the only way out buried in the popover,
            behind a click that looked like it was for editing. */}
        <div
          className={`h-[26px] rounded-md inline-flex items-stretch border overflow-hidden transition-colors ${
            !hasVideo || isProcessing ? 'opacity-40' : ''
          } ${
            segment.enabled
              ? 'bg-accent-500/12 border-accent-500/45 text-accent-400'
              : 'bg-ink-850 border-ink-750 text-ink-400 hover:border-ink-700'
          }`}
        >
          <button
            onClick={toggleSegment}
            disabled={!hasVideo || isProcessing}
            aria-pressed={segment.enabled}
            className={`px-2.5 inline-flex items-center gap-2 text-[12px] font-medium transition-colors disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500 ${
              segment.enabled ? 'hover:bg-accent-500/20' : 'hover:text-ink-200'
            }`}
            title={segment.enabled
              ? 'Turn segment selection off — process the whole video'
              : 'Process only part of the video'}
          >
            <Scissors className="w-3.5 h-3.5" />
            Segment
          </button>

          {segment.enabled && (
            <button
              onClick={() => setShowPopover(v => !v)}
              disabled={!hasVideo || isProcessing}
              aria-label="Segment options"
              aria-expanded={showPopover}
              className="px-1 grid place-items-center border-l border-accent-500/35 hover:bg-accent-500/20 transition-colors disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500"
              title="In and out points, frame exact"
            >
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showPopover ? 'rotate-180' : ''}`} />
            </button>
          )}
        </div>

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
