import { Upload, Video } from 'lucide-react';
import type { VideoInfo } from '../electron.d';

interface VideoInputPanelProps {
  videoInfo: VideoInfo | null;
  isDragging: boolean;
  isProcessing: boolean;
  onSelectVideo: () => Promise<void>;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => Promise<void>;
}

export function VideoInputPanel({
  videoInfo,
  isDragging,
  isProcessing,
  onSelectVideo,
  onDragOver,
  onDragLeave,
  onDrop,
}: VideoInputPanelProps) {
  return (
    <div className="flex-shrink-0 bg-dark-elevated rounded-xl border border-gray-800 p-4">
      <div className="flex items-center gap-2 mb-3">
        <Upload className="w-4 h-4 text-primary-blue" />
        <h2 className="text-sm font-semibold">Input Video</h2>
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
            <p className="text-sm font-medium mb-1 truncate">{videoInfo.name}</p>
            <p className="text-xs text-gray-400">{videoInfo.resolution} • {videoInfo.fps} FPS</p>
            <p className="text-xs text-gray-500 mt-0.5">{videoInfo.duration}</p>
          </div>
        ) : (
          <div>
            <Upload className="w-8 h-8 text-gray-600 mx-auto mb-2" />
            <p className="text-xs text-gray-400 mb-1">Drop video here or click to browse</p>
            <p className="text-xs text-gray-500">Supports MP4, MKV, AVI, and more</p>
          </div>
        )}
      </div>
    </div>
  );
}