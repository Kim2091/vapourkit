// VideoInfoPanel.tsx
import { memo } from 'react';
import { Info, ChevronUp, ChevronDown } from 'lucide-react';
import type { VideoInfo } from '../electron.d';

interface VideoInfoPanelProps {
  videoInfo: VideoInfo | null;
  showVideoInfo: boolean;
  onToggle: (value: boolean) => void;
}

export const VideoInfoPanel = memo<VideoInfoPanelProps>(({
  videoInfo,
  showVideoInfo,
  onToggle,
}: VideoInfoPanelProps) => {
  return (
    <div className="flex-shrink-0 bg-dark-elevated rounded-xl border border-gray-800 overflow-hidden">
      <button
        onClick={() => onToggle(!showVideoInfo)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-dark-surface/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <Info className="w-4 h-4 text-primary-blue" />
          <h2 className="text-base font-semibold">Video Info</h2>
        </div>
        {showVideoInfo ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>
      
      {showVideoInfo && (
        <div className="px-4 pb-4 space-y-4">
          {/* Input / Output Comparison */}
          <div className="grid grid-cols-2 gap-4">
            {/* Input Column */}
            <div className="space-y-3">
              <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider border-b border-gray-800 pb-1">Input</h3>
              
              <div>
                <p className="text-xs text-gray-500 uppercase mb-0.5">Resolution</p>
                <p className="text-sm font-medium">{videoInfo?.resolution || 'N/A'}</p>
              </div>
              
              <div>
                <p className="text-xs text-gray-500 uppercase mb-0.5">Frame Rate</p>
                <p className="text-sm font-medium">{videoInfo?.fps ? `${videoInfo.fps} FPS` : 'N/A'}</p>
              </div>

              <div>
                <p className="text-xs text-gray-500 uppercase mb-0.5">Codec</p>
                <p className="text-sm font-medium uppercase">{videoInfo?.codec || 'N/A'}</p>
              </div>

              <div>
                <p className="text-xs text-gray-500 uppercase mb-0.5">Scan Type</p>
                <p className={`text-sm font-medium ${videoInfo?.scanType?.includes('Interlaced') ? 'text-yellow-500' : ''}`}>
                  {videoInfo?.scanType || 'N/A'}
                </p>
              </div>

              <div>
                <p className="text-xs text-gray-500 uppercase mb-0.5">Format</p>
                <p className="text-xs font-medium text-gray-300 break-words" title={videoInfo?.colorSpace || videoInfo?.pixelFormat}>
                  {videoInfo?.pixelFormat || 'N/A'}
                </p>
              </div>
            </div>

            {/* Output Column */}
            <div className="space-y-3">
              <h3 className="text-xs font-bold text-primary-purple uppercase tracking-wider border-b border-gray-800 pb-1">Output</h3>
              
              <div>
                <p className="text-xs text-gray-500 uppercase mb-0.5">Resolution</p>
                <p className="text-sm font-medium text-primary-purple">{videoInfo?.outputResolution || 'N/A'}</p>
              </div>
              
              <div>
                <p className="text-xs text-gray-500 uppercase mb-0.5">Frame Rate</p>
                <p className="text-sm font-medium text-primary-purple">{videoInfo?.outputFps ? `${videoInfo.outputFps} FPS` : 'N/A'}</p>
              </div>

              <div>
                <p className="text-xs text-gray-500 uppercase mb-0.5">Codec</p>
                <p className="text-sm font-medium text-primary-purple uppercase">{videoInfo?.outputCodec || 'N/A'}</p>
              </div>

              <div>
                <p className="text-xs text-gray-500 uppercase mb-0.5">Scan Type</p>
                <p className="text-sm font-medium text-primary-purple">{videoInfo?.outputScanType || 'N/A'}</p>
              </div>

              <div>
                <p className="text-xs text-gray-500 uppercase mb-0.5">Format</p>
                <p className="text-xs font-medium text-primary-purple break-words">
                  {videoInfo?.outputPixelFormat || 'N/A'}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});