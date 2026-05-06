import { memo, useRef } from 'react';
import { Video, Loader2, CheckCircle, XCircle, FolderOpen, GitCompare } from 'lucide-react';
import { PrivacyVeil } from './PrivacyVeil';

interface VideoPreviewPanelProps {
  previewFrame: string | null;
  completedVideoPath: string | null;
  completedVideoBlobUrl: string | null;
  videoLoadError: boolean;
  isProcessing: boolean;
  segmentEnabled?: boolean;
  privacyMode: boolean;
  onCompareVideos: () => Promise<void>;
  onOpenOutputFolder: () => Promise<void>;
  onVideoError: () => void;
}

export const VideoPreviewPanel = memo<VideoPreviewPanelProps>(({
  previewFrame,
  completedVideoPath,
  completedVideoBlobUrl,
  videoLoadError,
  isProcessing,
  segmentEnabled,
  privacyMode,
  onCompareVideos,
  onOpenOutputFolder,
  onVideoError,
}: VideoPreviewPanelProps) => {
  const videoPlayerRef = useRef<HTMLVideoElement>(null);

  return (
    <div className="flex-1 bg-dark-elevated rounded-xl border border-gray-800/70 overflow-hidden flex flex-col min-h-0 card-hover">
      <div className="flex-shrink-0 px-3 py-2 border-b border-gray-800/70 flex items-center justify-between bg-dark-elevated/95 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <Video className="w-4 h-4 text-primary-purple" />
          <h2 className="font-semibold text-base">Output Preview</h2>
        </div>
        <div className="flex items-center gap-2">
          {/* Compare and Open Folder buttons - Only visible after processing */}
          {completedVideoPath && (
            <>
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onCompareVideos();
                }}
                disabled={segmentEnabled}
                className={`text-xs transition-colors flex items-center gap-1.5 px-2.5 py-1 rounded-lg ${
                  segmentEnabled 
                    ? 'text-gray-500 cursor-not-allowed bg-dark-surface/50' 
                    : 'text-primary-purple hover:text-purple-400 hover:bg-primary-purple/10'
                }`}
                title={segmentEnabled ? "Compare not available for segment-processed videos" : "Compare input and output videos side-by-side"}
              >
                <GitCompare className="w-3.5 h-3.5" />
                <span>Compare</span>
              </button>
              <button
                onClick={onOpenOutputFolder}
                className="text-xs text-accent-cyan hover:text-cyan-400 transition-colors flex items-center gap-1.5 px-2.5 py-1 rounded-lg hover:bg-accent-cyan/10"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                <span>Open Folder</span>
              </button>
            </>
          )}
        </div>
      </div>
      <div className="flex-1 flex items-center justify-center p-3 min-h-0 overflow-auto">
        {previewFrame ? (
          <PrivacyVeil
            enabled={privacyMode}
            className="w-full h-full"
            label="Preview hidden — click to reveal"
          >
            <div className="relative w-full h-full flex items-center justify-center">
              <img
                src={previewFrame}
                alt="Preview"
                className="w-full h-full object-contain rounded-lg shadow-lg"
                draggable={false}
                onDragStart={(e) => e.preventDefault()}
              />
              {isProcessing && (
                <div className="absolute top-3 right-3 bg-dark-bg/90 backdrop-blur-sm px-2.5 py-1.5 rounded-lg border border-primary-purple/30">
                  <div className="flex items-center gap-2">
                    <Loader2 className="w-4 h-4 text-primary-purple animate-spin" />
                    <span className="text-xs">Processing...</span>
                  </div>
                </div>
              )}
            </div>
          </PrivacyVeil>
        ) : completedVideoPath ? (
          <PrivacyVeil
            enabled={privacyMode}
            className="w-full h-full"
            label="Output hidden — click to reveal"
          >
            <div className="w-full h-full flex flex-col items-center justify-center gap-3">
              {videoLoadError ? (
                <div className="text-center">
                  <XCircle className="w-14 h-14 text-red-400 mx-auto mb-3 animate-pulse" />
                  <p className="text-gray-400 text-sm">Video format not supported in browser</p>
                  <p className="text-xs text-gray-500 mt-1.5">Use VLC or another player to view</p>
                </div>
              ) : completedVideoBlobUrl ? (
                <>
                  <video
                    ref={videoPlayerRef}
                    src={completedVideoBlobUrl}
                    controls
                    className="w-full h-full rounded-lg object-contain shadow-lg"
                    onError={onVideoError}
                  />
                  <div className="flex items-center gap-2 text-green-400 bg-green-500/10 px-3 py-1.5 rounded-lg border border-green-500/30">
                    <CheckCircle className="w-4 h-4" />
                    <span className="text-xs font-medium">Upscale complete!</span>
                  </div>
                </>
              ) : (
                <div className="text-center">
                  <Loader2 className="w-8 h-8 text-primary-purple animate-spin mx-auto mb-4" />
                  <p className="text-gray-400">Loading video...</p>
                </div>
              )}
            </div>
          </PrivacyVeil>
        ) : (
          <div className="text-center text-gray-500">
            <Video className="w-16 h-16 mx-auto mb-4 opacity-50" />
            <p>Preview will appear here during processing</p>
          </div>
        )}
      </div>
    </div>
  );
});