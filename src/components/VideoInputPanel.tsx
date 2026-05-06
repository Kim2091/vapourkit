import { memo } from 'react';
import { Upload, Video, List, PanelRightOpen, PanelRightClose } from 'lucide-react';
import type { VideoInfo } from '../electron.d';
import { PrivacyText } from './PrivacyVeil';

interface VideoInputPanelProps {
  videoInfo: VideoInfo | null;
  isDragging: boolean;
  isProcessing: boolean;
  queueCount: number;
  showQueue: boolean;
  indexingProgress: number | null;
  privacyMode: boolean;
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
  onSelectVideo,
  onDragOver,
  onDragLeave,
  onDrop,
  onToggleQueue,
}: VideoInputPanelProps) => {
  return (
    <div className="flex-shrink-0 bg-dark-elevated rounded-xl border border-gray-800 p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-3">
          <Upload className="w-4 h-4 text-primary-blue" />
          <h2 className="text-base font-semibold">Input Video</h2>
        </div>
        <button
          onClick={onToggleQueue}
          className={`flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg transition-all border ${
            showQueue
              ? 'bg-blue-500/10 border-blue-500/50 text-blue-400'
              : 'bg-dark-surface hover:bg-dark-bg border-gray-700 text-gray-400 hover:text-gray-300'
          }`}
          title={showQueue ? 'Hide queue' : 'Show queue'}
        >
          <List className="w-3.5 h-3.5" />
          <span>Queue {queueCount > 0 && `(${queueCount})`}</span>
          {showQueue ? <PanelRightClose className="w-3.5 h-3.5" /> : <PanelRightOpen className="w-3.5 h-3.5" />}
        </button>
      </div>

      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`border-2 border-dashed rounded-lg p-4 text-center transition-all duration-300 ${
          isDragging
            ? 'border-primary-purple bg-primary-purple/10'
            : 'border-gray-700 hover:border-gray-600'
        } ${isProcessing ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
        onClick={!isProcessing ? onSelectVideo : undefined}
      >
        {videoInfo ? (
          <div>
            <Video className="w-8 h-8 text-primary-purple mx-auto mb-2" />
            <p className="text-sm font-medium mb-1 truncate">
              <PrivacyText
                enabled={privacyMode}
                value={videoInfo.name}
                maskLength={12}
              />
            </p>
            <p className="text-xs text-gray-400">{videoInfo.resolution} • {videoInfo.fps} FPS • {videoInfo.sizeFormatted}</p>
            <p className="text-xs text-gray-500 mt-0.5">{videoInfo.duration}</p>
          </div>
        ) : (
          <div>
            <Upload className="w-8 h-8 text-gray-600 mx-auto mb-2" />
            <p className="text-xs text-gray-400 mb-1">Drop video(s) here or click to browse</p>
            <p className="text-xs text-gray-500">Select multiple to add to queue</p>
          </div>
        )}
      </div>

      {indexingProgress !== null && (
        <div className="mt-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-gray-400">Indexing video</span>
            <span className="text-xs text-gray-400 tabular-nums">{indexingProgress}%</span>
          </div>
          <div className="h-1.5 bg-dark-surface rounded-full overflow-hidden">
            <div
              className="h-full bg-primary-blue transition-all duration-200 ease-out"
              style={{ width: `${indexingProgress}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
});
