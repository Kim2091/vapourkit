import { memo } from 'react';
import { AlertCircle, Sparkles } from 'lucide-react';
import type { BackendId, ModelFile, UninitializedModel, Filter } from '../electron.d';
import { shouldShowBuildNotification } from '../utils/modelUtils';
import { resolveFilterBackend } from '../utils/backends';

interface ModelBuildNotificationProps {
  defaultBackend: BackendId;
  availableModels: ModelFile[];
  uninitializedModels: UninitializedModel[];
  filters: Filter[];
  onBuildModel: (model: UninitializedModel) => void;
}

export const ModelBuildNotification = memo<ModelBuildNotificationProps>(({
  defaultBackend,
  availableModels,
  uninitializedModels,
  filters,
  onBuildModel
}: ModelBuildNotificationProps) => {
  // Enabled AI-model filters, each judged against its own effective backend
  const aiFilters = filters.filter(f => f.enabled && f.filterType === 'aiModel' && f.modelPath);

  // If no models are in use, no notification needed
  if (aiFilters.length === 0) return null;

  // Find the first unbuilt model that's being used
  let unbuiltModelPath: string | null = null;
  for (const filter of aiFilters) {
    const modelObj = availableModels.find(m => m.path === filter.modelPath);
    const effectiveBackend = resolveFilterBackend(filter.backend, defaultBackend);
    if (shouldShowBuildNotification(modelObj ?? null, effectiveBackend)) {
      unbuiltModelPath = filter.modelPath!;
      break;
    }
  }

  // If no unbuilt models found, no notification needed
  if (!unbuiltModelPath) return null;
  
  // Check if there's an uninitialized model entry for this ONNX file
  const uninitModel = uninitializedModels.find(um => um.onnxPath === unbuiltModelPath);
  if (!uninitModel) return null;

  return (
    <div className="flex-shrink-0 bg-gradient-to-r from-warn-500/20 to-warn-500/20 border-b border-warn-500/30 px-6 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-warn-400 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-white">
              A model in your filter workflow needs to be built before use
            </p>
            <p className="text-xs text-ink-300">
              Click to configure and build TensorRT engine for optimal performance
            </p>
          </div>
        </div>
        <button
          onClick={() => onBuildModel(uninitModel)}
          className="bg-warn-500 hover:bg-warn-600 text-black font-semibold px-4 py-2 rounded-lg transition-all duration-300 flex items-center gap-2 flex-shrink-0"
        >
          <Sparkles className="w-4 h-4" />
          Configure & Build
        </button>
      </div>
    </div>
  );
});
