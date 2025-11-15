import { useRef } from 'react';
import { Video, Loader2, CheckCircle, XCircle, FolderOpen, GitCompare } from 'lucide-react';

interface VideoPreviewPanelProps {
  previewFrame: string | null;
  completedVideoPath: string | null;
  completedVideoBlobUrl: string | null;
  videoLoadError: boolean;
  isProcessing: boolean;
  onCompareVideos: () => Promise<void>;
  onOpenOutputFolder: () => Promise<void>;
  onVideoError: () => void;
}

export function VideoPreviewPanel({
  previewFrame,
  completedVideoPath,
  completedVideoBlobUrl,
  videoLoadError,
  isProcessing,
  onCompareVideos,
  onOpenOutputFolder,
  onVideoError,
}: VideoPreviewPanelProps) {
  const videoPlayerRef = useRef<HTMLVideoElement>(null);

  return (
    <div className="flex-1 bg-dark-elevated rounded-2xl border border-gray-800 overflow-hidden flex flex-col min-h-0">
      <div className="flex-shrink-0 px-4 py-3 border-b border-gray-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Video className="w-5 h-5 text-primary-purple" />
          <h2 className="font-semibold">Output Preview</h2>
        </div>
        {completedVideoPath && (
          <div className="flex items-center gap-2">
            <button
              onClick={onCompareVideos}
              className="text-sm text-primary-purple hover:text-purple-400 transition-colors flex items-center gap-2"
              title="Compare input and output videos side-by-side"
            >
              <GitCompare className="w-4 h-4" />
              Compare
            </button>
            <button
              onClick={onOpenOutputFolder}
              className="text-sm text-accent-cyan hover:text-cyan-400 transition-colors flex items-center gap-2"
            >
              <FolderOpen className="w-4 h-4" />
              Open Folder
            </button>
          </div>
        )}
      </div>
      <div className="flex-1 flex items-center justify-center p-4 min-h-0">
        {previewFrame ? (
          <div className="relative w-full h-full flex items-center justify-center">
            <img 
              src={previewFrame} 
              alt="Preview" 
              className="w-full h-full object-contain rounded-lg"
              draggable={false}
              onDragStart={(e) => e.preventDefault()}
            />
            {isProcessing && (
              <div className="absolute top-4 right-4 bg-dark-bg/90 backdrop-blur-sm px-3 py-2 rounded-lg border border-primary-purple/30">
                <div className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 text-primary-purple animate-spin" />
                  <span className="text-sm">Processing...</span>
                </div>
              </div>
            )}
          </div>
        ) : completedVideoPath ? (
          <div className="w-full h-full flex flex-col items-center justify-center gap-4">
            {videoLoadError ? (
              <div className="text-center">
                <XCircle className="w-16 h-16 text-red-400 mx-auto mb-4" />
                <p className="text-gray-400">Video format not supported in browser</p>
                <p className="text-sm text-gray-500 mt-2">Use VLC or another player to view</p>
              </div>
            ) : completedVideoBlobUrl ? (
              <>
                <video
                  ref={videoPlayerRef}
                  src={completedVideoBlobUrl}
                  controls
                  className="w-full h-full rounded-lg object-contain"
                  onError={onVideoError}
                />
                <div className="flex items-center gap-2 text-green-400">
                  <CheckCircle className="w-5 h-5" />
                  <span className="text-sm">Upscale complete!</span>
                </div>
              </>
            ) : (
              <div className="text-center">
                <Loader2 className="w-8 h-8 text-primary-purple animate-spin mx-auto mb-4" />
                <p className="text-gray-400">Loading video...</p>
              </div>
            )}
          </div>
        ) : (
          <div className="text-center text-gray-500">
            <Video className="w-16 h-16 mx-auto mb-4 opacity-50" />
            <p>Preview will appear here during processing</p>
          </div>
        )}
      </div>
    </div>
  );
}