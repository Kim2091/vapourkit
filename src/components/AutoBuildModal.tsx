import { memo } from 'react';
import { Loader2, Info, Sparkles, Lock } from 'lucide-react';
import type { ModelImportProgress } from '../electron.d';

interface AutoBuildModalProps {
  show: boolean;
  modelName: string;
  modelType: 'vsr' | 'image';
  progress: ModelImportProgress | null;
  isStatic?: boolean;
  staticShape?: string | null;
}

export const AutoBuildModal = memo<AutoBuildModalProps>(({
  show,
  modelName,
  modelType,
  progress,
  isStatic = false,
  staticShape = null,
}) => {
  if (!show) return null;

  const isVideoModel = modelType === 'vsr';
  
  // Parse static shape to extract resolution (format: 1x3x720x1280 or 1x15x720x1280)
  const getStaticResolution = (): string | null => {
    if (!staticShape) return null;
    const parts = staticShape.split('x');
    if (parts.length >= 4) {
      // Shape is [batch, channels, height, width]
      return `${parts[3]}x${parts[2]}`; // width x height
    }
    return null;
  };
  
  const staticResolution = getStaticResolution();

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-ink-900 border border-ink-750 rounded-lg shadow-2xl shadow-black/60 max-w-lg w-full overflow-hidden">
        {/* Header */}
        <div className="h-10 flex items-stretch gap-2.5 pr-2 bg-ink-850 border-b border-ink-800 rounded-t-lg overflow-hidden">
          <span className="w-[3px] bg-accent-500 flex-shrink-0" aria-hidden="true" />
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <Sparkles className="w-4 h-4 text-warn-400" />
            <h2 className="font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-100">Building TensorRT Engine</h2>
          </div>
        </div>

        {/* Content */}
        <div>
          {/* Model Info */}
          <section className="mt-2 border-t border-ink-700">
            <div className="h-9 flex items-stretch gap-2.5 bg-ink-850 border-b border-ink-800">
              <span className="w-[3px] bg-accent-500 flex-shrink-0" aria-hidden="true" />
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <h3 className="font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-100">Model Information</h3>
              </div>
            </div>
            <div className="h-8 flex items-center justify-between gap-3 px-4 border-b border-ink-900">
              <span className="text-[11.5px] text-ink-400">Model Name:</span>
              <span className="text-[12px] text-ink-200 font-medium truncate">{modelName}</span>
            </div>
            <div className="h-8 flex items-center justify-between gap-3 px-4 border-b border-ink-900">
              <span className="text-[11.5px] text-ink-400">Type:</span>
              <span className="text-[12px] text-ink-200 font-medium">
                {isVideoModel ? 'VSR (Video)' : 'Image (Single Frame)'}
              </span>
            </div>
            <div className="h-8 flex items-center justify-between gap-3 px-4 border-b border-ink-900">
              <span className="text-[11.5px] text-ink-400">Precision:</span>
              <span className="text-[12px] font-mono tabular-nums text-ink-200 font-medium">FP16</span>
            </div>
            <div className="h-8 flex items-center justify-between gap-3 px-4 border-b border-ink-900">
              <span className="text-[11.5px] text-ink-400">Shape Mode:</span>
              <span className={`text-[12px] font-medium flex items-center gap-1.5 ${isStatic ? 'text-warn-400' : 'text-accent-500'}`}>
                {isStatic && <Lock className="w-3 h-3" />}
                {isStatic ? 'Static' : 'Dynamic'}
              </span>
            </div>
          </section>

          {/* Supported Resolutions - Different display for static vs dynamic */}
          <section className="mt-2 border-t border-ink-700">
            <div className="h-9 flex items-stretch gap-2.5 bg-ink-850 border-b border-ink-800">
              <span className="w-[3px] bg-accent-500 flex-shrink-0" aria-hidden="true" />
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <h3 className="font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-100">
                  {isStatic ? 'Fixed Resolution' : 'Supported Resolutions'}
                </h3>
              </div>
            </div>
            {isStatic ? (
              <>
                <div className="h-8 flex items-center justify-between gap-3 px-4 border-b border-ink-900">
                  <span className="text-[11.5px] text-ink-400">Resolution:</span>
                  <span className="text-[12px] font-mono tabular-nums text-warn-400 font-medium">{staticResolution || staticShape}</span>
                </div>
                <p className="text-[11px] text-ink-500 px-4 py-2">
                  This model only supports a single fixed resolution.
                </p>
              </>
            ) : (
              <>
                <div className="h-8 flex items-center justify-between gap-3 px-4 border-b border-ink-900">
                  <span className="text-[11.5px] text-ink-400">Minimum:</span>
                  <span className="text-[12px] font-mono tabular-nums text-ink-200 font-medium">240x240</span>
                </div>
                <div className="h-8 flex items-center justify-between gap-3 px-4 border-b border-ink-900">
                  <span className="text-[11.5px] text-ink-400">Optimal:</span>
                  <span className="text-[12px] font-mono tabular-nums text-accent-500 font-medium">720x1280</span>
                </div>
                <div className="h-8 flex items-center justify-between gap-3 px-4 border-b border-ink-900">
                  <span className="text-[11.5px] text-ink-400">Maximum:</span>
                  <span className="text-[12px] font-mono tabular-nums text-ink-200 font-medium">1080x1920</span>
                </div>
              </>
            )}
          </section>

          {/* Progress */}
          {progress && (
            <div className="relative mt-2 px-4 py-2.5 bg-warn-500/10 border-t border-warn-500/30">
              <span
                className="absolute top-0 left-0 h-[2px] bg-warn-500 transition-all duration-300"
                style={{ width: `${progress.progress}%` }}
                role="progressbar"
                aria-valuenow={progress.progress}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Engine build progress"
              />
              <div className="flex items-center justify-between gap-3 mb-1">
                <span className="text-[12.5px] font-medium text-ink-200 truncate">{progress.message}</span>
                <span className="text-[12px] font-mono tabular-nums text-ink-400 flex-shrink-0">{progress.progress}%</span>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-ink-500">
                <Loader2 className="w-3.5 h-3.5 text-warn-400 animate-spin flex-shrink-0" />
                <span>This may take 5-15 minutes depending on your GPU...</span>
              </div>
            </div>
          )}

          {/* Info Box */}
          <div className="flex items-start gap-2.5 px-4 py-3">
            <Info className="w-3.5 h-3.5 text-ink-500 flex-shrink-0 mt-0.5" />
            <div className="text-[11px] text-ink-500 min-w-0">
              <p className="font-medium text-ink-400 mb-1">Building with preconfigured settings</p>
              <p>
                The TensorRT engine is being optimized for your GPU. This is a one-time process per model.
                {isVideoModel && ' This model processes 5-frame temporal sequences for better video quality.'}
                {isStatic && ' Static models are optimized for a single resolution.'}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});