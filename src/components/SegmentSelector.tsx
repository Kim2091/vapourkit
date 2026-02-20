import { memo, useState, useEffect, useCallback, useRef } from 'react';
import { Scissors, Play, SkipBack, SkipForward, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import type { VideoInfo, SegmentSelection } from '../electron.d';

export type { SegmentSelection };

interface SegmentSelectorProps {
  videoInfo: VideoInfo | null;
  segment: SegmentSelection;
  isProcessing: boolean;
  onSegmentChange: (segment: SegmentSelection) => void;
  onPreview?: (startFrame: number, endFrame: number) => void;
  onSeekFrame?: (frameNumber: number) => void;
}

// Helper to convert frame number to timecode string
function frameToTimecode(frame: number, fps: number): string {
  if (!fps || fps <= 0) return '--:--:--';
  const totalSeconds = frame / fps;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const frames = Math.floor((totalSeconds % 1) * fps);
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${frames.toString().padStart(2, '0')}`;
}

// Helper to parse timecode string to frame number
function timecodeToFrame(timecode: string, fps: number): number | null {
  if (!fps || fps <= 0) return null;
  
  // Support formats: HH:MM:SS.FF or HH:MM:SS or MM:SS or SS
  const parts = timecode.split(':');
  let hours = 0, minutes = 0, seconds = 0, frames = 0;
  
  if (parts.length === 3) {
    hours = parseInt(parts[0], 10) || 0;
    minutes = parseInt(parts[1], 10) || 0;
    const secFrames = parts[2].split('.');
    seconds = parseInt(secFrames[0], 10) || 0;
    frames = parseInt(secFrames[1] || '0', 10) || 0;
  } else if (parts.length === 2) {
    minutes = parseInt(parts[0], 10) || 0;
    const secFrames = parts[1].split('.');
    seconds = parseInt(secFrames[0], 10) || 0;
    frames = parseInt(secFrames[1] || '0', 10) || 0;
  } else if (parts.length === 1) {
    const secFrames = parts[0].split('.');
    seconds = parseInt(secFrames[0], 10) || 0;
    frames = parseInt(secFrames[1] || '0', 10) || 0;
  }
  
  const totalSeconds = hours * 3600 + minutes * 60 + seconds + frames / fps;
  return Math.round(totalSeconds * fps);
}

export const SegmentSelector = memo<SegmentSelectorProps>(({
  videoInfo,
  segment,
  isProcessing,
  onSegmentChange,
  onPreview,
  onSeekFrame,
}: SegmentSelectorProps) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [startInput, setStartInput] = useState('');
  const [endInput, setEndInput] = useState('');
  const [inputMode, setInputMode] = useState<'frames' | 'timecode'>('timecode');
  const [previewDuration, setPreviewDuration] = useState(5); // seconds
  
  const fps = videoInfo?.fps || 24;
  const totalFrames = videoInfo?.frameCount || 0;
  
  // Throttle frame seeking during drag to avoid overwhelming the system
  const lastSeekTimeRef = useRef<number>(0);
  const pendingSeekRef = useRef<number | null>(null);
  const seekTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  const throttledSeekFrame = useCallback((frameNumber: number) => {
    if (!onSeekFrame) return;
    
    const now = Date.now();
    const throttleMs = 100; // Seek at most every 100ms during drag
    
    if (now - lastSeekTimeRef.current >= throttleMs) {
      // Enough time has passed, seek immediately
      lastSeekTimeRef.current = now;
      pendingSeekRef.current = null;
      onSeekFrame(frameNumber);
    } else {
      // Store the pending frame and schedule it
      pendingSeekRef.current = frameNumber;
      
      if (!seekTimeoutRef.current) {
        seekTimeoutRef.current = setTimeout(() => {
          seekTimeoutRef.current = null;
          if (pendingSeekRef.current !== null) {
            lastSeekTimeRef.current = Date.now();
            onSeekFrame(pendingSeekRef.current);
            pendingSeekRef.current = null;
          }
        }, throttleMs - (now - lastSeekTimeRef.current));
      }
    }
  }, [onSeekFrame]);
  
  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (seekTimeoutRef.current) {
        clearTimeout(seekTimeoutRef.current);
      }
    };
  }, []);
  
  // Update inputs when segment changes or video changes
  useEffect(() => {
    if (inputMode === 'frames') {
      setStartInput(segment.startFrame.toString());
      setEndInput(segment.endFrame === -1 ? (totalFrames > 0 ? totalFrames.toString() : '') : segment.endFrame.toString());
    } else {
      setStartInput(frameToTimecode(segment.startFrame, fps));
      const endFrame = segment.endFrame === -1 ? totalFrames : segment.endFrame;
      setEndInput(frameToTimecode(endFrame, fps));
    }
  }, [segment.startFrame, segment.endFrame, fps, totalFrames, inputMode]);
  
  // Reset segment when video changes
  useEffect(() => {
    if (videoInfo && totalFrames > 0) {
      // Only reset if endFrame is -1 (unset) or exceeds total frames
      if (segment.endFrame === -1 || segment.endFrame > totalFrames) {
        onSegmentChange({
          ...segment,
          endFrame: totalFrames,
        });
      }
    }
  }, [videoInfo, totalFrames]);
  
  const handleToggle = useCallback((enabled: boolean) => {
    onSegmentChange({
      ...segment,
      enabled,
    });
  }, [segment, onSegmentChange]);
  
  const handleStartChange = useCallback((value: string) => {
    setStartInput(value);
  }, []);
  
  const handleEndChange = useCallback((value: string) => {
    setEndInput(value);
  }, []);
  
  const handleStartBlur = useCallback(() => {
    let frame: number;
    if (inputMode === 'frames') {
      frame = parseInt(startInput, 10) || 0;
    } else {
      frame = timecodeToFrame(startInput, fps) ?? 0;
    }
    
    // Clamp values
    frame = Math.max(0, Math.min(frame, totalFrames > 0 ? totalFrames - 1 : 0));
    
    // Ensure start < end
    const currentEnd = segment.endFrame === -1 ? totalFrames : segment.endFrame;
    if (frame >= currentEnd) {
      frame = Math.max(0, currentEnd - 1);
    }
    
    onSegmentChange({
      ...segment,
      startFrame: frame,
    });
    
    // Seek to the new start frame
    if (onSeekFrame) {
      onSeekFrame(frame);
    }
  }, [startInput, inputMode, fps, totalFrames, segment, onSegmentChange, onSeekFrame]);
  
  const handleEndBlur = useCallback(() => {
    let frame: number;
    if (inputMode === 'frames') {
      frame = parseInt(endInput, 10) || totalFrames;
    } else {
      frame = timecodeToFrame(endInput, fps) ?? totalFrames;
    }
    
    // Clamp values
    frame = Math.max(1, Math.min(frame, totalFrames > 0 ? totalFrames : 1));
    
    // Ensure end > start
    if (frame <= segment.startFrame) {
      frame = Math.min(totalFrames, segment.startFrame + 1);
    }
    
    onSegmentChange({
      ...segment,
      endFrame: frame,
    });
    
    // Seek to the new end frame
    if (onSeekFrame) {
      onSeekFrame(frame);
    }
  }, [endInput, inputMode, fps, totalFrames, segment, onSegmentChange, onSeekFrame]);
  
  const handleReset = useCallback(() => {
    onSegmentChange({
      ...segment,
      startFrame: 0,
      endFrame: totalFrames > 0 ? totalFrames : -1,
    });
  }, [segment, totalFrames, onSegmentChange]);
  
  const handlePreview = useCallback(() => {
    if (!onPreview || !videoInfo) return;
    
    // Calculate preview based on user-selected duration (or remaining duration if less)
    const previewFrames = Math.ceil(fps * previewDuration);
    const endFrame = segment.endFrame === -1 ? totalFrames : segment.endFrame;
    const previewEnd = Math.min(segment.startFrame + previewFrames, endFrame);
    
    onPreview(segment.startFrame, previewEnd);
  }, [onPreview, videoInfo, segment, fps, totalFrames, previewDuration]);
  
  // Dragging state for timeline handles
  const [dragging, setDragging] = useState<'start' | 'end' | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  
  // Handle drag start
  const handleDragStart = useCallback((handle: 'start' | 'end') => (e: React.MouseEvent | React.TouchEvent) => {
    if (isProcessing) return;
    e.preventDefault();
    setDragging(handle);
  }, [isProcessing]);
  
  // Handle drag move
  useEffect(() => {
    if (!dragging || !timelineRef.current) return;
    
    const handleMove = (clientX: number) => {
      const rect = timelineRef.current!.getBoundingClientRect();
      const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const frame = Math.round(percent * totalFrames);
      
      if (dragging === 'start') {
        const currentEnd = segment.endFrame === -1 ? totalFrames : segment.endFrame;
        const newStart = Math.max(0, Math.min(frame, currentEnd - 1));
        onSegmentChange({
          ...segment,
          startFrame: newStart,
        });
        // Seek to the new start frame (throttled)
        throttledSeekFrame(newStart);
      } else {
        const newEnd = Math.max(segment.startFrame + 1, Math.min(frame, totalFrames));
        onSegmentChange({
          ...segment,
          endFrame: newEnd,
        });
        // Seek to the new end frame (throttled)
        throttledSeekFrame(newEnd);
      }
    };
    
    const handleMouseMove = (e: MouseEvent) => handleMove(e.clientX);
    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length > 0) handleMove(e.touches[0].clientX);
    };
    
    const handleEnd = () => setDragging(null);
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleEnd);
    document.addEventListener('touchmove', handleTouchMove);
    document.addEventListener('touchend', handleEnd);
    
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleEnd);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleEnd);
    };
  }, [dragging, totalFrames, segment, onSegmentChange, throttledSeekFrame]);
  
  // Calculate segment duration and frame count
  const segmentEndFrame = segment.endFrame === -1 ? totalFrames : segment.endFrame;
  const segmentFrameCount = segmentEndFrame - segment.startFrame;
  const segmentDuration = segmentFrameCount / fps;
  const segmentDurationStr = `${Math.floor(segmentDuration / 60)}:${(segmentDuration % 60).toFixed(2).padStart(5, '0')}`;
  
  // Calculate percentage of video selected
  const selectionPercent = totalFrames > 0 ? ((segmentFrameCount / totalFrames) * 100).toFixed(1) : '100';
  
  if (!videoInfo) {
    return null;
  }
  
  return (
    <div className="bg-dark-elevated rounded-xl border border-gray-800">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <button
          onClick={() => segment.enabled && setIsExpanded(!isExpanded)}
          className="flex items-center gap-2 flex-1 hover:opacity-80 transition-opacity min-w-0"
          disabled={!segment.enabled}
        >
          <Scissors className="w-4 h-4 text-orange-400 flex-shrink-0" />
          <h2 className="text-base font-semibold">Segment Selection</h2>
          {segment.enabled && !isExpanded && (
            <span className="text-sm text-gray-400 ml-2">
              {frameToTimecode(segment.startFrame, fps)} → {frameToTimecode(segmentEndFrame, fps)}
            </span>
          )}
          {segment.enabled && (
            isExpanded 
              ? <ChevronUp className="w-4 h-4 ml-auto flex-shrink-0" /> 
              : <ChevronDown className="w-4 h-4 ml-auto flex-shrink-0" />
          )}
        </button>
        <div className="flex items-center gap-2 ml-3">
          <input
            type="checkbox"
            id="segment-enabled"
            checked={segment.enabled}
            onChange={(e) => handleToggle(e.target.checked)}
            disabled={isProcessing}
            className="w-4 h-4 rounded border-gray-700 bg-dark-elevated text-orange-500 focus:ring-2 focus:ring-orange-500 focus:ring-offset-0 disabled:opacity-50 disabled:cursor-not-allowed"
            title={segment.enabled ? "Disable segment selection" : "Enable segment selection"}
          />
        </div>
      </div>
      
      {/* Content */}
      {isExpanded && segment.enabled && (
        <div className="px-4 pb-4 space-y-4 border-t border-gray-800 pt-4">
          {/* Input Mode Dropdown */}
          <div className="space-y-2">
            <label className="block text-sm text-gray-400">Input mode</label>
            <select
              value={inputMode}
              onChange={(e) => setInputMode(e.target.value as 'frames' | 'timecode')}
              disabled={isProcessing}
              className="w-full bg-dark-surface border border-gray-700 rounded-lg px-3 py-2 text-base focus:outline-none focus:border-orange-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option value="timecode">Timecode (HH:MM:SS.FF)</option>
              <option value="frames">Frame Numbers</option>
            </select>
          </div>
              
              {/* Start/End Inputs */}
              <div className="grid grid-cols-2 gap-4">
                {/* Start Point (Marker A) */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <SkipBack className="w-4 h-4 text-green-400" />
                    <label className="text-sm font-medium text-gray-300">Start (A)</label>
                  </div>
                  <input
                    type="text"
                    value={startInput}
                    onChange={(e) => handleStartChange(e.target.value)}
                    onBlur={handleStartBlur}
                    onKeyDown={(e) => e.key === 'Enter' && handleStartBlur()}
                    disabled={isProcessing}
                    placeholder={inputMode === 'frames' ? '0' : '00:00:00.00'}
                    className="w-full bg-dark-surface border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-green-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                  <p className="text-xs text-gray-500">
                    {inputMode === 'frames' 
                      ? `Timecode: ${frameToTimecode(segment.startFrame, fps)}`
                      : `Frame: ${segment.startFrame}`
                    }
                  </p>
                </div>
                
                {/* End Point (Marker B) */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <SkipForward className="w-4 h-4 text-red-400" />
                    <label className="text-sm font-medium text-gray-300">End (B)</label>
                  </div>
                  <input
                    type="text"
                    value={endInput}
                    onChange={(e) => handleEndChange(e.target.value)}
                    onBlur={handleEndBlur}
                    onKeyDown={(e) => e.key === 'Enter' && handleEndBlur()}
                    disabled={isProcessing}
                    placeholder={inputMode === 'frames' ? totalFrames.toString() : frameToTimecode(totalFrames, fps)}
                    className="w-full bg-dark-surface border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-red-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                  <p className="text-xs text-gray-500">
                    {inputMode === 'frames' 
                      ? `Timecode: ${frameToTimecode(segmentEndFrame, fps)}`
                      : `Frame: ${segmentEndFrame}`
                    }
                  </p>
                </div>
              </div>
              
              {/* Visual Timeline with Draggable Brackets */}
              <div className="space-y-2">
                <div 
                  ref={timelineRef}
                  className="relative h-8 bg-gray-800 rounded-lg overflow-visible select-none"
                >
                  {/* Full video background */}
                  <div className="absolute inset-0 bg-gray-700/50 rounded-lg" />
                  
                  {/* Selected segment highlight */}
                  <div 
                    className="absolute h-full bg-gradient-to-r from-green-500/40 via-orange-500/40 to-red-500/40"
                    style={{
                      left: `${totalFrames > 0 ? (segment.startFrame / totalFrames) * 100 : 0}%`,
                      width: `${totalFrames > 0 ? (segmentFrameCount / totalFrames) * 100 : 100}%`,
                    }}
                  />
                  
                  {/* Start bracket handle (draggable) */}
                  <div 
                    className={`absolute top-0 bottom-0 w-3 cursor-ew-resize z-10 group ${dragging === 'start' ? 'z-20' : ''}`}
                    style={{ 
                      left: `calc(${totalFrames > 0 ? (segment.startFrame / totalFrames) * 100 : 0}% - 6px)`,
                    }}
                    onMouseDown={handleDragStart('start')}
                    onTouchStart={handleDragStart('start')}
                  >
                    {/* Bracket shape [ */}
                    <div className={`absolute inset-y-0 left-1/2 w-2 flex flex-col justify-center items-start transition-colors ${dragging === 'start' ? 'opacity-100' : 'group-hover:opacity-100'}`}>
                      <div className="w-2 h-full bg-green-500 rounded-l-sm shadow-lg shadow-green-500/50 flex flex-col justify-between py-0.5">
                        <div className="w-full h-1.5 bg-green-400 rounded-sm" />
                        <div className="w-full h-1.5 bg-green-400 rounded-sm" />
                      </div>
                    </div>
                    {/* Hover/drag indicator line */}
                    <div className={`absolute top-0 bottom-0 left-1/2 w-0.5 bg-green-500 transform -translate-x-1/2 ${dragging === 'start' ? 'shadow-lg shadow-green-400' : ''}`} />
                  </div>
                  
                  {/* End bracket handle (draggable) */}
                  <div 
                    className={`absolute top-0 bottom-0 w-3 cursor-ew-resize z-10 group ${dragging === 'end' ? 'z-20' : ''}`}
                    style={{ 
                      left: `calc(${totalFrames > 0 ? (segmentEndFrame / totalFrames) * 100 : 100}% - 6px)`,
                    }}
                    onMouseDown={handleDragStart('end')}
                    onTouchStart={handleDragStart('end')}
                  >
                    {/* Bracket shape ] */}
                    <div className={`absolute inset-y-0 right-1/2 w-2 flex flex-col justify-center items-end transition-colors ${dragging === 'end' ? 'opacity-100' : 'group-hover:opacity-100'}`}>
                      <div className="w-2 h-full bg-red-500 rounded-r-sm shadow-lg shadow-red-500/50 flex flex-col justify-between py-0.5">
                        <div className="w-full h-1.5 bg-red-400 rounded-sm" />
                        <div className="w-full h-1.5 bg-red-400 rounded-sm" />
                      </div>
                    </div>
                    {/* Hover/drag indicator line */}
                    <div className={`absolute top-0 bottom-0 left-1/2 w-0.5 bg-red-500 transform -translate-x-1/2 ${dragging === 'end' ? 'shadow-lg shadow-red-400' : ''}`} />
                  </div>
                  
                  {/* Time markers at bottom */}
                  <div className="absolute bottom-0 left-0 right-0 h-1 flex">
                    {[0, 25, 50, 75, 100].map((percent) => (
                      <div 
                        key={percent} 
                        className="absolute bottom-0 w-px h-1 bg-gray-500/50"
                        style={{ left: `${percent}%` }}
                      />
                    ))}
                  </div>
                </div>
                
                {/* Stats */}
                <div className="flex items-center justify-between text-xs text-gray-400">
                  <span>{segmentFrameCount.toLocaleString()} frames</span>
                  <span>{segmentDurationStr}</span>
                  <span>{selectionPercent}% of video</span>
                </div>
              </div>
              
              {/* Action Buttons */}
              <div className="flex gap-2 items-center">
                {onPreview && (
                  <>
                    <button
                      onClick={handlePreview}
                      disabled={isProcessing || segmentFrameCount < 1}
                      className="flex items-center justify-center gap-2 px-4 py-2 bg-blue-500/20 border border-blue-500/50 text-blue-400 rounded-lg hover:bg-blue-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      title={`Render a ${previewDuration} second test clip from start point`}
                    >
                      <Play className="w-4 h-4" />
                      Render Test Clip
                    </button>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min="1"
                        max="15"
                        value={previewDuration}
                        onChange={(e) => setPreviewDuration(parseInt(e.target.value, 10))}
                        disabled={isProcessing}
                        className="w-20 h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                        title="Preview duration"
                      />
                      <span className="text-xs text-gray-400 w-6">{previewDuration}s</span>
                    </div>
                  </>
                )}
                <button
                  onClick={handleReset}
                  disabled={isProcessing}
                  className="flex items-center justify-center gap-2 px-4 py-2 bg-gray-700/50 border border-gray-600 text-gray-300 rounded-lg hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Reset to full video"
                >
                  <RefreshCw className="w-4 h-4" />
                  Reset
                </button>
              </div>
              
              {/* Info Note */}
              <div className="p-3 bg-gray-800/50 rounded-lg border border-gray-700/50">
                <p className="text-xs text-gray-400">
                  <strong className="text-gray-300">Tip:</strong> Drag the green and red bracket handles on the timeline to adjust the segment, or enter values directly.
                  Use Render Test Clip to test your filter settings on a short sample (1-15 seconds) before processing the full segment.
                </p>
              </div>
        </div>
      )}
    </div>
  );
});
