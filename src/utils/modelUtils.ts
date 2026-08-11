import type { BackendId, ModelFile } from '../electron.d';
import { getBackendDescriptor } from './backends';

// NOTE: ModelFile.backend describes the model FILE kind ('tensorrt' = built
// .engine file, 'onnx' = portable .onnx file), not the inference backend the
// user selected — that's the BackendId parameter below.

/**
 * Filters and sorts models based on an inference backend.
 *
 * Rules:
 * - Backends that run ONNX directly (DirectML, NCNN, OpenVINO): only ONNX models
 * - Engine-building backends (TensorRT): ALL models (engines + all ONNX for
 *   rebuilding), with engines sorted to the top
 */
export function filterModels(
  models: ModelFile[],
  backendId: BackendId
): ModelFile[] {
  const backend = getBackendDescriptor(backendId);

  const filtered = models.filter(model => {
    if (backend.requiresEngineBuild) {
      // Show engines + all ONNX (allows rebuilding)
      return model.backend === 'tensorrt' || model.backend === 'onnx';
    }
    // ONNX-direct backends: only show ONNX models
    return model.backend === 'onnx';
  });

  // For engine-building backends, sort engines to the top
  if (backend.requiresEngineBuild) {
    return filtered.sort((a, b) => {
      // Engines first
      if (a.backend === 'tensorrt' && b.backend !== 'tensorrt') return -1;
      if (a.backend !== 'tensorrt' && b.backend === 'tensorrt') return 1;
      // Maintain original order for same file kind
      return 0;
    });
  }

  return filtered;
}

/**
 * Gets the display name for a model with appropriate labels.
 * Engine-building backends add an [Unbuilt] prefix for ONNX without engines.
 */
export function getModelDisplayName(
  model: ModelFile,
  backendId: BackendId
): string {
  // Build display name: base name + optional display tag
  let displayName = model.name;

  // Add display tag if available
  if (model.displayTag) {
    displayName = `${displayName} [${model.displayTag}]`;
  }

  // Add [Unbuilt] label for ONNX without engines when the backend builds engines
  if (getBackendDescriptor(backendId).requiresEngineBuild && model.backend === 'onnx' && !model.hasEngine) {
    displayName = '[Unbuilt] ' + displayName;
  }

  return displayName;
}

/**
 * Checks if a model needs to be built before use with the given backend.
 * Returns true for an ONNX model without a built engine when the backend
 * requires engines.
 */
export function modelNeedsBuild(
  model: ModelFile | null,
  backendId: BackendId
): boolean {
  if (!model || !getBackendDescriptor(backendId).requiresEngineBuild) {
    return false;
  }

  return model.backend === 'onnx' && !model.hasEngine;
}

/**
 * Checks if a model should show the build notification.
 * Shows notification for ANY ONNX model (allows rebuilding).
 */
export function shouldShowBuildNotification(
  model: ModelFile | null,
  backendId: BackendId
): boolean {
  if (!model || !getBackendDescriptor(backendId).requiresEngineBuild) {
    return false;
  }

  // Show notification for ANY ONNX model (allows rebuilding)
  return model.backend === 'onnx';
}

/**
 * Extracts all AI model paths from enabled filters.
 * Used to determine which models are actually being used.
 */
export function getEnabledAIModelPaths(filters: Array<{ 
  enabled: boolean; 
  filterType: string; 
  modelPath?: string 
}>): string[] {
  return filters
    .filter(f => f.enabled && f.filterType === 'aiModel' && f.modelPath)
    .map(f => f.modelPath!);
}

/**
 * Extracts a portable model name from a full model path.
 * Removes the precision suffix (_fp16, _fp32) and file extension (.onnx, .engine).
 * 
 * Examples:
 * - "C:\...\2x-AniRemaster_TSPAN_fp16.onnx" -> "2x-AniRemaster_TSPAN"
 * - "C:\...\2x-AniRemaster_TSPAN_fp16_fp16.engine" -> "2x-AniRemaster_TSPAN"
 * - "2x-AnimeSharpV4_Fast_fp16.onnx" -> "2x-AnimeSharpV4_Fast"
 */
export function getPortableModelName(modelPath: string): string {
  // Extract filename from path
  const filename = modelPath.split(/[\\/]/).pop() || modelPath;
  
  // Remove file extension (.onnx, .engine, etc.)
  let baseName = filename.replace(/\.(onnx|engine)$/i, '');
  
  // Remove precision suffixes (_fp16, _fp32)
  // Handle cases like "_fp16_fp16" (double suffix from engine builds)
  baseName = baseName.replace(/_fp(16|32)(_fp(16|32))?$/i, '');
  
  return baseName;
}

/**
 * Resolves a portable model name to an actual model path from available models.
 * Looks for any model that matches the base name, regardless of precision or extension.
 * Prefers TensorRT engines over ONNX models when both are available.
 * 
 * @param portableModelName - The portable model name (e.g., "2x-AniRemaster_TSPAN")
 * @param availableModels - List of available models
 * @returns The full path to the matching model, or null if not found
 */
export function resolvePortableModelName(
  portableModelName: string,
  availableModels: ModelFile[]
): string | null {
  if (!portableModelName) {
    return null;
  }
  
  // Find all models that match the portable name
  const matchingModels = availableModels.filter(model => {
    const modelPortableName = getPortableModelName(model.path);
    return modelPortableName === portableModelName;
  });
  
  if (matchingModels.length === 0) {
    return null;
  }
  
  // Prefer TensorRT engines over ONNX models
  const engineModel = matchingModels.find(m => m.backend === 'tensorrt');
  if (engineModel) {
    return engineModel.path;
  }
  
  // Fall back to first ONNX model
  const onnxModel = matchingModels.find(m => m.backend === 'onnx');
  if (onnxModel) {
    return onnxModel.path;
  }
  
  // Return first available match as last resort
  return matchingModels[0].path;
}
