import React from 'react';
import { Loader2, Info, Sparkles } from 'lucide-react';
import type { ModelImportProgress } from '../electron.d';

interface AutoBuildModalProps {
  show: boolean;
  modelName: string;
  modelType: 'tspan' | 'image';
  progress: ModelImportProgress | null;
}

export const AutoBuildModal: React.FC<AutoBuildModalProps> = ({
  show,
  modelName,
  modelType,
  progress,
}) => {
  if (!show) return null;

  const isVideoModel = modelType === 'tspan';
  const minResolution = '240x240';
  const optimalResolution = '720x1280';
  const maxResolution = '1080x1920';

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-dark-elevated rounded-2xl border border-gray-800 shadow-2xl max-w-lg w-full">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-800">
          <div className="flex items-center gap-3">
            <Sparkles className="w-6 h-6 text-yellow-400" />
            <h2 className="text-2xl font-bold">Building TensorRT Engine</h2>
          </div>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Model Info */}
          <div className="bg-dark-surface rounded-lg p-4 border border-gray-700">
            <h3 className="text-sm font-semibold mb-3 text-gray-300">Model Information</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-400">Model Name:</span>
                <span className="text-white font-medium">{modelName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Type:</span>
                <span className="text-white font-medium">
                  {isVideoModel ? 'TSPAN (Video)' : 'Image (Single Frame)'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Precision:</span>
                <span className="text-white font-medium">FP16</span>
              </div>
            </div>
          </div>

          {/* Supported Resolutions */}
          <div className="bg-dark-surface rounded-lg p-4 border border-gray-700">
            <h3 className="text-sm font-semibold mb-3 text-gray-300">Supported Resolutions</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-400">Minimum:</span>
                <span className="text-white font-medium">{minResolution}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Optimal:</span>
                <span className="text-accent-cyan font-medium">{optimalResolution}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Maximum:</span>
                <span className="text-white font-medium">{maxResolution}</span>
              </div>
            </div>
          </div>

          {/* Progress */}
          {progress && (
            <div className="bg-dark-surface rounded-lg p-4 border border-gray-700">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">{progress.message}</span>
                <span className="text-sm text-gray-400">{progress.progress}%</span>
              </div>
              <div className="w-full bg-dark-bg rounded-full h-2 mb-3">
                <div 
                  className="bg-gradient-to-r from-yellow-400 to-orange-500 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${progress.progress}%` }}
                />
              </div>
              <div className="flex items-center gap-2 text-xs text-gray-400">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>This may take 5-15 minutes depending on your GPU...</span>
              </div>
            </div>
          )}

          {/* Info Box */}
          <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <Info className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-gray-300">
                <p className="font-medium mb-1">Building with preconfigured settings</p>
                <p className="text-xs text-gray-400">
                  The TensorRT engine is being optimized for your GPU. This is a one-time process per model.
                  {isVideoModel && ' This model processes 5-frame temporal sequences for better video quality.'}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};