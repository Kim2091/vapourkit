// VideoInfoPanel.tsx
import { Info, ChevronUp, ChevronDown } from 'lucide-react';
import type { VideoInfo } from '../electron.d';

interface VideoInfoPanelProps {
  videoInfo: VideoInfo | null;
  showVideoInfo: boolean;
  onToggle: (value: boolean) => void;
}

export function VideoInfoPanel({
  videoInfo,
  showVideoInfo,
  onToggle,
}: VideoInfoPanelProps) {
  return (
    <div className="flex-shrink-0 bg-dark-elevated rounded-xl border border-gray-800 overflow-hidden">
      <button
        onClick={() => onToggle(!showVideoInfo)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-dark-surface/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Info className="w-4 h-4 text-primary-blue" />
          <h2 className="text-base font-semibold">Video Info</h2>
        </div>
        {showVideoInfo ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>
      
      {showVideoInfo && (
        <div className="px-4 pb-3 space-y-2">
          <div>
            <p className="text-sm text-gray-500 uppercase mb-0.5">File Name</p>
            <p className="text-sm font-medium break-all">{videoInfo?.name || 'N/A'}</p>
          </div>
          <div>
            <p className="text-sm text-gray-500 uppercase mb-0.5">File Size</p>
            <p className="text-sm font-medium">{videoInfo?.sizeFormatted || 'N/A'}</p>
          </div>
          <div>
            <p className="text-sm text-gray-500 uppercase mb-0.5">Input Resolution</p>
            <p className="text-sm font-medium">{videoInfo?.resolution || 'N/A'}</p>
          </div>
          <div>
            <p className="text-sm text-gray-500 uppercase mb-0.5">Output Resolution</p>
            <p className="text-sm font-medium text-primary-purple">
              {videoInfo?.outputResolution || 'N/A'}
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-500 uppercase mb-0.5">Frame Rate</p>
            <p className="text-sm font-medium">{videoInfo?.fps ? `${videoInfo.fps} FPS` : 'N/A'}</p>
          </div>
          <div>
            <p className="text-sm text-gray-500 uppercase mb-0.5">Output Frame Rate</p>
            <p className="text-sm font-medium text-primary-purple">
              {videoInfo?.outputFps ? `${videoInfo.outputFps} FPS` : 'N/A'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}