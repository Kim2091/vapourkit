import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Video, Loader2, XCircle, FolderOpen, GitCompare, Crop, X, Palette, Ban, Pipette } from 'lucide-react';
import { PrivacyVeil } from './PrivacyVeil';
import { CropEditorOverlay } from './CropEditorOverlay';
import { ColorGradeOverlay, type CompareMode } from './ColorGradeOverlay';
import { GradeScopeColumn } from './GradeScopeColumn';
import { PreviewStepRail } from './PreviewStepRail';
import { ChainPreviewCanvas } from './ChainPreviewCanvas';
import { sampleFrame, sampleBuffer } from '../utils/gradeRenderer';
import type { GradeValues } from '../utils/colorGrade';
import type { ChainPreviewFrame, ChainPreviewStep } from '../hooks/useChainPreview';
import type { Filter, FilterParameterValues } from '../electron.d';

/** The open preview session, as the panel needs to see it. */
export interface ChainPreview {
  steps: ChainPreviewStep[];
  selected: number;
  frame: ChainPreviewFrame | null;
  isRendering: boolean;
  isStale: boolean;
  /**
   * The one step the live grade belongs on: the output feeding the open grade
   * step. Selected elsewhere, the shader must stay out of the way, or an
   * upstream step would be shown wearing a grade that is not applied to it.
   */
  liveGradeStep: number | null;
  /**
   * First step carrying a grade baked in at load. While the dock is open,
   * this step and everything after it show stale values, so they are offered
   * as unavailable rather than as truth.
   */
  bakedFromStep: number | null;
  onSelect: (index: number) => void;
  onReload: () => void;
}

/** Everything the preview needs to show an open grade step. */
export interface GradePreview {
  values: GradeValues;
  mode: CompareMode;
  holdingBefore: boolean;
  stepLabel: string;
  onModeChange: (mode: CompareMode) => void;
  /** Solve this grade's lift so a sampled pixel becomes the black point. */
  onPickBlack?: (sample: [number, number, number]) => void;
}

const COMPARE_MODES: { id: CompareMode; label: string; title: string }[] = [
  { id: 'wipe', label: 'Wipe', title: 'Drag the divider to compare across the frame' },
  { id: 'after', label: 'After', title: 'Show the graded frame in full' },
];

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
  /** Set when the active editor is a colour grade. */
  gradePreview?: GradePreview | null;
  /** Fires with a small RGB sample of the ungraded frame, for the scopes. */
  onFrameSampled?: (sample: Float32Array | null) => void;
  /** That same sample, back again, for the scope column beside the picture. */
  scopeSample?: Float32Array | null;
  /** Width for the scope column, or 0 when the pane is too narrow for one. */
  scopeColumnWidth?: number;
  /** Fires with the width the handle was dragged to. */
  onScopeColumnResize?: (width: number) => void;
  /** Double-clicking the handle gives the width back to the automatic rule. */
  onScopeColumnReset?: () => void;
  /** The grading panel's type base, shared with the dock. */
  gradeBasePx?: number;
  /** Set while a preview session is open, so the panel shows the chain. */
  chainPreview?: ChainPreview | null;
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
  gradePreview = null,
  onFrameSampled,
  scopeSample = null,
  scopeColumnWidth = 0,
  onScopeColumnResize,
  onScopeColumnReset,
  gradeBasePx = 12,
  chainPreview = null,
}: VideoPreviewPanelProps) => {
  const videoPlayerRef = useRef<HTMLVideoElement>(null);
  const previewImageRef = useRef<HTMLImageElement>(null);
  const [previewImageSize, setPreviewImageSize] = useState<{ width: number; height: number } | null>(null);
  const [resizingScopes, setResizingScopes] = useState(false);
  // Panel-local: it is a way of looking at the picture, not part of the grade,
  // and it should hold while stepping between steps and frames.
  const [showClipping, setShowClipping] = useState(false);
  const [picking, setPicking] = useState(false);
  const cropEditor = activeFilterEditor?.editor?.type === 'crop' ? activeFilterEditor.editor : null;

  // Dragging left widens the column, so the delta is subtracted. The parent
  // owns the clamping: it is the one that knows the pane's width.
  const beginScopeResize = useCallback((event: React.MouseEvent) => {
    if (!onScopeColumnResize) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = scopeColumnWidth;
    setResizingScopes(true);
    const onMove = (move: MouseEvent) => onScopeColumnResize(startWidth - (move.clientX - startX));
    const onUp = () => {
      setResizingScopes(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  }, [onScopeColumnResize, scopeColumnWidth]);

  // A data: URL can finish loading before this effect flushes, so clearing
  // unconditionally would discard a size onLoad had already recorded and
  // leave it null for good. Re-read the element instead of assuming.
  useEffect(() => {
    const image = previewImageRef.current;
    setPreviewImageSize(image?.complete && image.naturalWidth
      ? { width: image.naturalWidth, height: image.naturalHeight }
      : null);
  }, [previewFrame]);

  // The scopes grade a small sample of the frame rather than the frame itself,
  // so it is taken once here when the picture changes.
  const handleImageLoad = useCallback((image: HTMLImageElement) => {
    setPreviewImageSize({ width: image.naturalWidth, height: image.naturalHeight });
    if (!onFrameSampled) return;
    onFrameSampled(sampleFrame(image, image.naturalWidth, image.naturalHeight));
  }, [onFrameSampled]);

  // A session frame never becomes an <img>, so it is sampled from the buffer
  // instead. Same scopes, real pixels.
  const chainFrame = chainPreview?.frame ?? null;

  // The grade belongs on exactly one step: the one feeding it. Anywhere else
  // the picture is shown as it renders.
  const gradeIsLive = Boolean(
    gradePreview &&
    chainPreview &&
    chainPreview.liveGradeStep !== null &&
    chainPreview.selected === chainPreview.liveGradeStep,
  );

  // Clip marks are drawn by the shader, so they need a picture going through
  // it: any session frame, or the scrubber frame once a grade has put the
  // overlay over it. A bare <img> has nothing to stripe.
  const canShowClipping = Boolean(chainFrame || (previewFrame && gradePreview));

  // The picker solves this grade's lift from the picture entering it. In a
  // session that is only true on the step feeding the grade; outside one the
  // <img> is that picture by definition.
  const canPickBlack = Boolean(
    gradePreview?.onPickBlack && (chainFrame ? gradeIsLive : previewFrame),
  );

  // Disarmed the moment it stops being offered — otherwise closing the dock or
  // stepping off the grade's input leaves a click armed with no way to see it.
  useEffect(() => {
    if (!canPickBlack) setPicking(false);
  }, [canPickBlack]);

  useEffect(() => {
    if (!chainFrame || !onFrameSampled) return;
    onFrameSampled(sampleBuffer(chainFrame.pixels, chainFrame.width, chainFrame.height));
  }, [chainFrame, onFrameSampled]);

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
          {gradePreview && (
            <>
              <span className="inline-flex items-center gap-1 h-5 px-1.5 rounded border border-accent-500/40 bg-accent-500/10 text-[10px] font-semibold uppercase tracking-[0.08em] text-accent-300 truncate flex-shrink-0">
                <Palette className="w-3 h-3 flex-shrink-0" />
                Grade
              </span>
              <div className="flex rounded border border-ink-750 overflow-hidden flex-shrink-0">
                {COMPARE_MODES.map(mode => (
                  <button
                    key={mode.id}
                    onClick={() => gradePreview.onModeChange(mode.id)}
                    aria-pressed={gradePreview.mode === mode.id}
                    title={mode.title}
                    className={`px-1.5 h-[18px] text-[10px] border-r border-ink-750 last:border-r-0 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-500 ${
                      gradePreview.mode === mode.id ? 'bg-accent-500/16 text-accent-300' : 'text-ink-500 hover:text-ink-300'
                    }`}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
              <span className={`text-[10px] whitespace-nowrap flex-shrink-0 ${gradePreview.holdingBefore ? 'text-accent-300' : 'text-ink-600'}`}>
                Hold <kbd className="font-mono">B</kbd> for before
              </span>
            </>
          )}
          {/* Grading tools, not chain tools: they belong to the picture, so
              they stay put whether or not a preview session is open. */}
          {canPickBlack && (
            <button
              onClick={() => setPicking(value => !value)}
              aria-pressed={picking}
              title="Click something that should be black, and lift is solved per channel to put it there — level and colour cast in one go."
              className={`inline-flex items-center gap-1 h-[18px] px-1.5 rounded border text-[10px] whitespace-nowrap flex-shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-500 ${
                picking
                  ? 'border-accent-500/50 bg-accent-500/12 text-accent-300'
                  : 'border-ink-750 text-ink-500 hover:text-ink-300'
              }`}
            >
              <Pipette className="w-3 h-3" />
              {picking ? 'Pick a black' : 'Black point'}
            </button>
          )}
          {canShowClipping && (
            <button
              onClick={() => setShowClipping(value => !value)}
              aria-pressed={showClipping}
              title="Stripe the pixels sitting on the clip point — red at the top, blue at the bottom. Follows the grade as you drag it."
              className={`inline-flex items-center gap-1 h-[18px] px-1.5 rounded border text-[10px] whitespace-nowrap flex-shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-500 ${
                showClipping
                  ? 'border-accent-500/50 bg-accent-500/12 text-accent-300'
                  : 'border-ink-750 text-ink-500 hover:text-ink-300'
              }`}
            >
              <Ban className="w-3 h-3" />
              Clip
            </button>
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
              className="h-[22px] px-2 rounded inline-flex items-center gap-1 text-[11px] font-semibold border border-accent-500 bg-accent-500 text-accent-ink hover:bg-accent-400 hover:border-accent-400 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-1 focus-visible:ring-offset-ink-850"
              title="Close visual filter editor"
            >
              <X className="w-3.5 h-3.5" />
              <span>Close editor</span>
            </button>
          )}
        </div>
      </div>
      {chainPreview && (
        <PreviewStepRail
          steps={chainPreview.steps}
          selected={chainPreview.selected}
          isRendering={chainPreview.isRendering}
          isStale={chainPreview.isStale}
          bakedFromStep={chainPreview.bakedFromStep}
          frame={chainFrame}
          frameSize={chainFrame ? { width: chainFrame.width, height: chainFrame.height } : null}
          onSelect={chainPreview.onSelect}
          onReload={chainPreview.onReload}
        />
      )}
      <div className="flex-1 flex min-h-0 min-w-0">
      <div className="flex-1 flex items-center justify-center p-3 min-h-0 min-w-0 overflow-auto">
        {chainFrame ? (
          <PrivacyVeil
            enabled={privacyMode}
            className="w-full h-full"
            label="Preview hidden — click to reveal"
          >
            <div className="relative w-full h-full flex items-center justify-center">
              {/* With a grade step open the session sits on the step below it,
                  so this texture is the picture entering the grade and the
                  shader can apply it live. No round trip, real pixels. */}
              <ChainPreviewCanvas
                frame={chainFrame}
                gradeValues={gradeIsLive ? gradePreview!.values : null}
                holdingBefore={gradeIsLive && gradePreview!.holdingBefore}
                mode={gradePreview?.mode}
                showClipping={showClipping}
                picking={picking}
                onPick={(sample) => {
                  gradePreview?.onPickBlack?.(sample);
                  // One pick per arming, so a stray second click cannot
                  // silently re-solve against the picture it just changed.
                  setPicking(false);
                }}
                stepLabel={gradePreview?.stepLabel}
              />
            </div>
          </PrivacyVeil>
        ) : previewFrame ? (
          <PrivacyVeil
            enabled={privacyMode}
            className="w-full h-full"
            label="Preview hidden — click to reveal"
          >
            <div className="relative w-full h-full flex items-center justify-center">
              <img
                ref={previewImageRef}
                src={previewFrame}
                alt="Preview"
                className="w-full h-full object-contain rounded-lg shadow-lg"
                draggable={false}
                onDragStart={(e) => e.preventDefault()}
                onLoad={(event) => handleImageLoad(event.currentTarget)}
              />
              {gradePreview && (
                <ColorGradeOverlay
                  imageRef={previewImageRef}
                  frameSize={previewImageSize}
                  values={gradePreview.values}
                  mode={gradePreview.mode}
                  holdingBefore={gradePreview.holdingBefore}
                  stepLabel={gradePreview.stepLabel}
                  showClipping={showClipping}
                  picking={picking}
                  onPick={(sample) => {
                    gradePreview.onPickBlack?.(sample);
                    // One pick per arming, as on the session path.
                    setPicking(false);
                  }}
                />
              )}
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

      {/* Scopes, beside the picture rather than under it. A 16:9 picture is
          bound by the pane's height, so this column is drawn from width the
          picture could not have used anyway. */}
      {gradePreview && scopeColumnWidth > 0 && (
        <>
          <div
            onMouseDown={beginScopeResize}
            onDoubleClick={onScopeColumnReset}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the scopes"
            title="Drag to resize the scopes — double-click to fit them to the spare width"
            className={`w-[5px] flex-shrink-0 cursor-ew-resize relative transition-colors ${
              resizingScopes ? 'bg-accent-500/30' : 'hover:bg-accent-500/20'
            }`}
          >
            <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-ink-800" aria-hidden="true" />
          </div>
          <GradeScopeColumn
            sample={scopeSample}
            values={gradePreview.values}
            width={scopeColumnWidth}
            basePx={gradeBasePx}
          />
        </>
      )}
      </div>
    </div>
  );
});
