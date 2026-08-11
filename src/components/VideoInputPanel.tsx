import { memo } from 'react';
import { Upload, Video, List, PanelRightOpen, PanelRightClose, RefreshCw } from 'lucide-react';
import type { VideoInfo } from '../electron.d';
import { PrivacyText } from './PrivacyVeil';
import { Section, SectionButton } from './Section';

interface VideoInputPanelProps {
  videoInfo: VideoInfo | null;
  isDragging: boolean;
  isProcessing: boolean;
  queueCount: number;
  showQueue: boolean;
  indexingProgress: number | null;
  privacyMode: boolean;
  /** e.g. "editing 2 of 4" when a queue item is the edit target. */
  editingLabel?: string;
  onSelectVideo: () => Promise<void>;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => Promise<void>;
  onToggleQueue: () => void;
}

export const VideoInputPanel = memo<VideoInputPanelProps>(({
  videoInfo,
  isDragging,
  isProcessing,
  queueCount,
  showQueue,
  indexingProgress,
  privacyMode,
  editingLabel,
  onSelectVideo,
  onDragOver,
  onDragLeave,
  onDrop,
  onToggleQueue,
}: VideoInputPanelProps) => {
  // The whole row stays a drop target either way — but once a file is loaded
  // the instructions have done their job, so they stop taking up space.
  const loaded = Boolean(videoInfo);

  return (
    <Section
      title="Source"
      meta={editingLabel}
      actions={
        <SectionButton
          onClick={onToggleQueue}
          active={showQueue}
          title={showQueue ? 'Hide queue' : 'Show queue'}
        >
          <List className="w-3 h-3" />
          Queue{queueCount > 0 && ` (${queueCount})`}
          {showQueue ? <PanelRightClose className="w-3 h-3" /> : <PanelRightOpen className="w-3 h-3" />}
        </SectionButton>
      }
    >
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={!isProcessing ? onSelectVideo : undefined}
        role="button"
        tabIndex={isProcessing ? -1 : 0}
        onKeyDown={(e) => {
          if (!isProcessing && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            onSelectVideo();
          }
        }}
        title={loaded ? 'Click to choose a different video' : 'Click to browse, or drop files here'}
        className={`border-b border-ink-900 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500 ${
          isDragging ? 'bg-accent-500/12 ring-1 ring-inset ring-accent-500/50' : 'hover:bg-ink-850/60'
        } ${isProcessing ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
      >
        {loaded ? (
          <div className="flex items-center gap-3 px-3 py-2">
            <div className="w-11 h-[26px] rounded flex-shrink-0 bg-ink-800 grid place-items-center">
              <Video className="w-3.5 h-3.5 text-ink-500" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] text-ink-200 truncate">
                <PrivacyText enabled={privacyMode} value={videoInfo!.name} maskLength={12} />
              </p>
              <p className="text-[11px] text-ink-500 font-mono tabular-nums truncate">
                {videoInfo!.resolution} · {videoInfo!.fps} fps · {videoInfo!.sizeFormatted} · {videoInfo!.duration}
              </p>
            </div>
            <RefreshCw className="w-3.5 h-3.5 text-ink-600 flex-shrink-0" />
          </div>
        ) : (
          <div className="flex items-center gap-3 px-3 py-3">
            <Upload className="w-4 h-4 text-ink-500 flex-shrink-0" />
            <div className="min-w-0">
              <p className="text-[12.5px] text-ink-300">Drop video(s) here or click to browse</p>
              <p className="text-[11px] text-ink-500">Select multiple to add them to the queue</p>
            </div>
          </div>
        )}
      </div>

      {indexingProgress !== null && (
        <div className="px-3 py-2 border-b border-ink-900">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] text-ink-400">Indexing video</span>
            <span className="text-[11px] text-ink-400 tabular-nums">{indexingProgress}%</span>
          </div>
          <div className="h-1 bg-ink-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-accent-500 transition-all duration-200 ease-out"
              style={{ width: `${indexingProgress}%` }}
            />
          </div>
        </div>
      )}
    </Section>
  );
});
