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
    <div className="flex-shrink-0 flex items-center gap-3 px-4 py-2 bg-warn-500/10 border-b border-warn-500/30">
      <AlertCircle className="w-4 h-4 text-warn-400 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-medium text-ink-200 truncate">
          A model in your filter workflow needs to be built before use
        </p>
        <p className="text-[12px] text-ink-400">
          Click to configure and build TensorRT engine for optimal performance
        </p>
      </div>
      <button
        onClick={() => onBuildModel(uninitModel)}
        className="h-8 px-3 rounded-md inline-flex items-center gap-2 text-[12.5px] font-semibold bg-warn-600 border border-warn-600 text-ink-950 hover:bg-warn-500 transition-colors flex-shrink-0"
      >
        <Sparkles className="w-4 h-4" />
        Configure & Build
      </button>
    </div>
  );
});
