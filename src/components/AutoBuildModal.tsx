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
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-ink-850 rounded-2xl border border-ink-800 shadow-2xl max-w-lg w-full">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-ink-800">
          <div className="flex items-center gap-3">
            <Sparkles className="w-6 h-6 text-warn-400" />
            <h2 className="text-2xl font-bold">Building TensorRT Engine</h2>
          </div>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Model Info */}
          <div className="bg-ink-900 rounded-lg p-4 border border-ink-700">
            <h3 className="text-sm font-semibold mb-3 text-ink-300">Model Information</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-ink-400">Model Name:</span>
                <span className="text-white font-medium">{modelName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-400">Type:</span>
                <span className="text-white font-medium">
                  {isVideoModel ? 'VSR (Video)' : 'Image (Single Frame)'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-400">Precision:</span>
                <span className="text-white font-medium">FP16</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-400">Shape Mode:</span>
                <span className={`font-medium flex items-center gap-1.5 ${isStatic ? 'text-warn-400' : 'text-accent-500'}`}>
                  {isStatic && <Lock className="w-3.5 h-3.5" />}
                  {isStatic ? 'Static' : 'Dynamic'}
                </span>
              </div>
            </div>
          </div>

          {/* Supported Resolutions - Different display for static vs dynamic */}
          <div className="bg-ink-900 rounded-lg p-4 border border-ink-700">
            <h3 className="text-sm font-semibold mb-3 text-ink-300">
              {isStatic ? 'Fixed Resolution' : 'Supported Resolutions'}
            </h3>
            {isStatic ? (
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-ink-400">Resolution:</span>
                  <span className="text-warn-400 font-medium">{staticResolution || staticShape}</span>
                </div>
                <p className="text-xs text-ink-500 mt-2">
                  This model only supports a single fixed resolution.
                </p>
              </div>
            ) : (
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-ink-400">Minimum:</span>
                  <span className="text-white font-medium">240x240</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-400">Optimal:</span>
                  <span className="text-accent-500 font-medium">720x1280</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-400">Maximum:</span>
                  <span className="text-white font-medium">1080x1920</span>
                </div>
              </div>
            )}
          </div>

          {/* Progress */}
          {progress && (
            <div className="bg-ink-900 rounded-lg p-4 border border-ink-700">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">{progress.message}</span>
                <span className="text-sm text-ink-400">{progress.progress}%</span>
              </div>
              <div className="w-full bg-ink-950 rounded-full h-2 mb-3">
                <div 
                  className="bg-gradient-to-r from-warn-400 to-warn-500 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${progress.progress}%` }}
                />
              </div>
              <div className="flex items-center gap-2 text-xs text-ink-400">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>This may take 5-15 minutes depending on your GPU...</span>
              </div>
            </div>
          )}

          {/* Info Box */}
          <div className="bg-accent-500/10 border border-accent-500/30 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <Info className="w-5 h-5 text-accent-400 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-ink-300">
                <p className="font-medium mb-1">Building with preconfigured settings</p>
                <p className="text-xs text-ink-400">
                  The TensorRT engine is being optimized for your GPU. This is a one-time process per model.
                  {isVideoModel && ' This model processes 5-frame temporal sequences for better video quality.'}
                  {isStatic && ' Static models are optimized for a single resolution.'}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});