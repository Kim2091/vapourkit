import { AlertCircle, Sparkles } from 'lucide-react';
import type { ModelFile, UninitializedModel, Filter } from '../electron.d';
import { shouldShowBuildNotification, getEnabledAIModelPaths } from '../utils/modelUtils';

interface ModelBuildNotificationProps {
  useDirectML: boolean;
  selectedModel: string | null;
  filteredModels: ModelFile[];
  uninitializedModels: UninitializedModel[];
  advancedMode: boolean;
  filters: Filter[];
  onBuildModel: (model: UninitializedModel) => void;
  onAutoBuild: (model: UninitializedModel) => void;
}

export const ModelBuildNotification = ({
  useDirectML,
  selectedModel,
  filteredModels,
  uninitializedModels,
  advancedMode,
  filters,
  onBuildModel,
  onAutoBuild
}: ModelBuildNotificationProps) => {
  // Collect all model paths that are being used
  const modelsInUse: string[] = [];
  
  if (advancedMode) {
    // In advanced mode, check filter selections
    modelsInUse.push(...getEnabledAIModelPaths(filters));
  } else {
    // In simple mode, check selectedModel
    if (selectedModel) {
      modelsInUse.push(selectedModel);
    }
  }
  
  // If no models are in use, no notification needed
  if (modelsInUse.length === 0) return null;
  
  // Find the first unbuilt model that's being used
  let unbuiltModelPath: string | null = null;
  for (const modelPath of modelsInUse) {
    const modelObj = filteredModels.find(m => m.path === modelPath);
    if (shouldShowBuildNotification(modelObj ?? null, useDirectML, advancedMode)) {
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
              {advancedMode ? 'A model in your filter workflow' : 'Selected model'} needs to be built before use
            </p>
            <p className="text-xs text-gray-300">
              {advancedMode 
                ? 'Click to configure and build TensorRT engine for optimal performance'
                : 'Click to build TensorRT engine with preconfigured settings'}
            </p>
          </div>
        </div>
        <button
          onClick={() => {
            if (advancedMode) {
              onBuildModel(uninitModel);
            } else {
              onAutoBuild(uninitModel);
            }
          }}
          className="bg-yellow-500 hover:bg-yellow-600 text-black font-semibold px-4 py-2 rounded-lg transition-all duration-300 flex items-center gap-2 flex-shrink-0"
        >
          <Sparkles className="w-4 h-4" />
          {advancedMode ? 'Configure & Build' : 'Build Model'}
        </button>
      </div>
    </div>
  );
};