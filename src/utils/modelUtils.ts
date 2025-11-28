import type { ModelFile } from '../electron.d';

/**
 * Filters and sorts models based on the current backend and advanced mode settings.
 * 
 * Rules:
 * - DirectML mode: Show only ONNX models
 * - TensorRT mode (Simple): Show engines + ONNX models WITHOUT built engines
 * - TensorRT mode (Advanced): Show ALL models (engines + all ONNX)
 * - TensorRT mode: Engines are always sorted to the top
 */
export function filterModels(
  models: ModelFile[],
  useDirectML: boolean,
  advancedMode: boolean
): ModelFile[] {
  const filtered = models.filter(model => {
    if (useDirectML) {
      // DirectML: Only show ONNX models
      return model.backend === 'onnx';
    } else {
      // TensorRT mode: Show engines + conditional ONNX
      if (model.backend === 'tensorrt') {
        return true;
      }
      
      if (model.backend === 'onnx') {
        if (advancedMode) {
          // Advanced: Show all ONNX models (even if engine exists)
          return true;
        } else {
          // Simple: Only show ONNX models WITHOUT engines (hide duplicates)
          return !model.hasEngine;
        }
      }
      
      return false;
    }
  });

  // In TensorRT mode, sort engines to the top
  if (!useDirectML) {
    return filtered.sort((a, b) => {
      // TensorRT engines first
      if (a.backend === 'tensorrt' && b.backend !== 'tensorrt') return -1;
      if (a.backend !== 'tensorrt' && b.backend === 'tensorrt') return 1;
      // Maintain original order for same backend type
      return 0;
    });
  }

  return filtered;
}

/**
 * Gets the display name for a model with appropriate labels.
 * 
 * Rules:
 * - DirectML mode: Show name with display tag if available
 * - TensorRT mode (Simple): Show name with display tag if available
 * - TensorRT mode (Advanced): Add [Unbuilt] prefix for ONNX without engines
 */
export function getModelDisplayName(
  model: ModelFile,
  useDirectML: boolean,
  advancedMode: boolean
): string {
  // Build display name: base name + optional display tag
  let displayName = model.name;
  
  // Add display tag if available
  if (model.displayTag) {
    displayName = `${displayName} [${model.displayTag}]`;
  }
  
  // Add [Unbuilt] label only in TensorRT advanced mode for ONNX without engines
  if (!useDirectML && advancedMode && model.backend === 'onnx' && !model.hasEngine) {
    displayName = '[Unbuilt] ' + displayName;
  }
  
  return displayName;
}

/**
 * Checks if a model needs to be built before use.
 * Returns true if the model is an ONNX model without a built engine in TensorRT mode.
 */
export function modelNeedsBuild(
  model: ModelFile | null,
  useDirectML: boolean
): boolean {
  if (!model || useDirectML) {
    return false;
  }
  
  return model.backend === 'onnx' && !model.hasEngine;
}

/**
 * Checks if a model should show the build notification.
 * In advanced mode: ANY ONNX model (allows rebuilding)
 * In simple mode: Only ONNX models without engines
 */
export function shouldShowBuildNotification(
  model: ModelFile | null,
  useDirectML: boolean,
  advancedMode: boolean
): boolean {
  if (!model || useDirectML) {
    return false;
  }
  
  if (advancedMode) {
    // In advanced mode, show notification for ANY ONNX model (allows rebuilding)
    return model.backend === 'onnx';
  } else {
    // In simple mode, only show for unbuilt ONNX models
    return model.backend === 'onnx' && !model.hasEngine;
  }
}

/**
 * Checks if a selected model path is still valid after settings change.
 * Used to determine if we need to auto-switch to a different model.
 */
export function isModelStillValid(
  selectedModelPath: string | null,
  filteredModels: ModelFile[]
): boolean {
  if (!selectedModelPath) {
    return false;
  }
  
  return filteredModels.some(m => m.path === selectedModelPath);
}

/**
 * Extracts all AI model paths from enabled filters.
 * Used in advanced mode to determine which models are actually being used.
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
