import { memo, useEffect, useRef, useState } from 'react';
import { Video, Loader2, XCircle, FolderOpen, GitCompare, Crop, X } from 'lucide-react';
import { PrivacyVeil } from './PrivacyVeil';
import { CropEditorOverlay } from './CropEditorOverlay';
import type { Filter, FilterParameterValues } from '../electron.d';

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
  /** The selected filter whose template requested an interactive preview editor. */
  activeFilterEditor?: Filter | null;
  onCloseFilterEditor?: () => void;
  onFilterParametersChange?: (filterId: string, parameters: FilterParameterValues) => void;
  /** Original video dimensions. The scrubber preview is downscaled for speed. */
  cropSourceSize?: { width: number; height: number } | null;
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
  activeFilterEditor = null,
  onCloseFilterEditor,
  onFilterParametersChange,
  cropSourceSize,
}: VideoPreviewPanelProps) => {
  const videoPlayerRef = useRef<HTMLVideoElement>(null);
  const [previewImageSize, setPreviewImageSize] = useState<{ width: number; height: number } | null>(null);
  const cropEditor = activeFilterEditor?.editor?.type === 'crop' ? activeFilterEditor.editor : null;

  useEffect(() => {
    setPreviewImageSize(null);
  }, [previewFrame]);

  return (
    <div className="flex-1 bg-ink-950 overflow-hidden flex flex-col min-h-0">
      <div className="flex-shrink-0 h-9 pr-3 border-b border-ink-800 flex items-stretch gap-2.5 bg-ink-850">
        <span className="w-[3px] bg-accent-500 flex-shrink-0" aria-hidden="true" />
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <span className="font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-100 whitespace-nowrap">Preview</span>
          {activeFilterEditor && cropEditor && (
            <span className="inline-flex items-center gap-1 h-5 px-1.5 rounded border border-accent-500/40 bg-accent-500/10 text-[10px] font-semibold uppercase tracking-[0.08em] text-accent-300 truncate">
              <Crop className="w-3 h-3 flex-shrink-0" />
              {cropEditor.label || 'Crop editor'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 self-center">
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
                className={`h-[22px] px-2 rounded inline-flex items-center gap-1.5 text-[11px] font-medium border transition-colors ${
                  segmentEnabled 
                    ? 'text-ink-600 cursor-not-allowed bg-ink-850 border-ink-800' 
                    : 'bg-ink-850 border-ink-750 text-ink-400 hover:text-ink-200 hover:border-ink-700'
                }`}
                title={segmentEnabled ? "Compare not available for segment-processed videos" : "Compare input and output videos side-by-side"}
              >
                <GitCompare className="w-3.5 h-3.5" />
                <span>Compare</span>
              </button>
              <button
                onClick={onOpenOutputFolder}
                className="h-[22px] px-2 rounded inline-flex items-center gap-1.5 text-[11px] font-medium border bg-ink-850 border-ink-750 text-ink-400 hover:text-ink-200 hover:border-ink-700 transition-colors"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                <span>Open Folder</span>
              </button>
            </>
          )}
          {activeFilterEditor && (
            <button
              onClick={onCloseFilterEditor}
              className="h-[22px] px-2 rounded inline-flex items-center gap-1 text-[11px] font-medium border bg-ink-850 border-ink-750 text-ink-400 hover:text-ink-200 hover:border-ink-700 transition-colors"
              title="Close visual filter editor"
            >
              <X className="w-3.5 h-3.5" />
              <span>Close editor</span>
            </button>
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
                onLoad={(event) => setPreviewImageSize({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })}
              />
              {cropEditor && activeFilterEditor && (
                <CropEditorOverlay
                  editor={cropEditor}
                  parameters={activeFilterEditor.parameters}
                  sourceSize={cropSourceSize ?? previewImageSize}
                  disabled={isProcessing}
                  onCommit={(parameters) => onFilterParametersChange?.(activeFilterEditor.id, parameters)}
                  onClose={() => onCloseFilterEditor?.()}
                />
              )}
              {isProcessing && (
                <div className="absolute top-3 right-3 bg-ink-950/90 backdrop-blur-sm px-2.5 py-1.5 rounded-lg border border-accent-500/30">
                  <div className="flex items-center gap-2">
                    <Loader2 className="w-4 h-4 text-accent-500 animate-spin" />
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
                  <XCircle className="w-14 h-14 text-bad-400 mx-auto mb-3 animate-pulse" />
                  <p className="text-ink-400 text-sm">Video format not supported in browser</p>
                  <p className="text-xs text-ink-500 mt-1.5">Use VLC or another player to view</p>
                </div>
              ) : completedVideoBlobUrl ? (
                // No completion badge under the player — an h-full video plus
                // anything else overflows the pane into a scrollbar. Completion
                // already shows via the header's Compare/Folder buttons.
                <video
                  ref={videoPlayerRef}
                  src={completedVideoBlobUrl}
                  controls
                  className="w-full h-full rounded-lg object-contain shadow-lg"
                  onError={onVideoError}
                />
              ) : (
                <div className="text-center">
                  <Loader2 className="w-8 h-8 text-accent-500 animate-spin mx-auto mb-4" />
                  <p className="text-ink-400">Loading video...</p>
                </div>
              )}
            </div>
          </PrivacyVeil>
        ) : (
          <div className="text-center text-ink-600">
            <Video className="w-10 h-10 mx-auto mb-3 opacity-60" />
            <p className="text-[12.5px]">Preview will appear here during processing</p>
          </div>
        )}
      </div>
    </div>
  );
});
