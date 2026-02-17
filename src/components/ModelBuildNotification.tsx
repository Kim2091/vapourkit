import { memo } from 'react';
import { AlertCircle, Sparkles } from 'lucide-react';
import type { ModelFile, UninitializedModel, Filter } from '../electron.d';
import { shouldShowBuildNotification, getEnabledAIModelPaths } from '../utils/modelUtils';

interface ModelBuildNotificationProps {
  useDirectML: boolean;
  availableModels: ModelFile[];
  uninitializedModels: UninitializedModel[];
  filters: Filter[];
  onBuildModel: (model: UninitializedModel) => void;
}

export const ModelBuildNotification = memo<ModelBuildNotificationProps>(({
  useDirectML,
  availableModels,
  uninitializedModels,
  filters,
  onBuildModel
}: ModelBuildNotificationProps) => {
  // Collect all model paths that are being used from filter selections
  const modelsInUse = getEnabledAIModelPaths(filters);
  
  // If no models are in use, no notification needed
  if (modelsInUse.length === 0) return null;
  
  // Find the first unbuilt model that's being used
  let unbuiltModelPath: string | null = null;
  for (const modelPath of modelsInUse) {
    const modelObj = availableModels.find(m => m.path === modelPath);
    if (shouldShowBuildNotification(modelObj ?? null, useDirectML)) {
      unbuiltModelPath = modelPath;
      break;
    }
  }
  
  // If no unbuilt models found, no notification needed
  if (!unbuiltModelPath) return null;
  
  // Check if there's an uninitialized model entry for this ONNX file
  const uninitModel = uninitializedModels.find(um => um.onnxPath === unbuiltModelPath);
  if (!uninitModel) return null;

  return (
    <div className="flex-shrink-0 bg-gradient-to-r from-yellow-500/20 to-orange-500/20 border-b border-yellow-500/30 px-6 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-yellow-400 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-white">
              A model in your filter workflow needs to be built before use
            </p>
            <p className="text-xs text-gray-300">
              Click to configure and build TensorRT engine for optimal performance
            </p>
          </div>
        </div>
        <button
          onClick={() => onBuildModel(uninitModel)}
          className="bg-yellow-500 hover:bg-yellow-600 text-black font-semibold px-4 py-2 rounded-lg transition-all duration-300 flex items-center gap-2 flex-shrink-0"
        >
          <Sparkles className="w-4 h-4" />
          Configure & Build
        </button>
      </div>
    </div>
  );
});
