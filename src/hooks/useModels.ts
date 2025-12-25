import { useState, useEffect, useCallback, useMemo } from 'react';
import type { ModelFile, UninitializedModel } from '../electron.d';
import { filterModels, isModelStillValid } from '../utils/modelUtils';

export const useModels = (isSetupComplete: boolean, useDirectML: boolean) => {
  const [availableModels, setAvailableModels] = useState<ModelFile[]>([]);
  const [uninitializedModels, setUninitializedModels] = useState<UninitializedModel[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);

  const loadModels = useCallback(async (): Promise<void> => {
    try {
      const models = await window.electronAPI.getAvailableModels();
      setAvailableModels(models);
      // Use functional updater to avoid dependency on selectedModel
      setSelectedModel(prev => {
        // If no model selected yet and we have models, select the first one
        if (prev === null && models.length > 0) {
          return models[0].path;
        }
        // If currently selected model was deleted, select first available
        if (prev && models.length > 0 && !models.some(m => m.path === prev)) {
          return models[0].path;
        }
        // If no models available, clear selection
        if (models.length === 0) {
          return null;
        }
        // Keep current selection
        return prev;
      });
    } catch (error) {
      console.error('Error loading models:', error);
    }
  }, []); // No dependencies - stable function identity

  const loadUninitializedModels = useCallback(async (): Promise<void> => {
    try {
      const models = await window.electronAPI.getUninitializedModels();
      setUninitializedModels(models);
    } catch (error) {
      console.error('Error loading uninitialized models:', error);
    }
  }, []);

  // Filter models based on DirectML setting
  const filteredModels = useMemo(() => {
    return filterModels(availableModels, useDirectML);
  }, [availableModels, useDirectML]);

  // Update selected model when DirectML setting changes
  // Only validate when useDirectML changes, not on every filteredModels update
  // to avoid race conditions when loading new models
  useEffect(() => {
    if (filteredModels.length > 0 && selectedModel && !isModelStillValid(selectedModel, filteredModels)) {
      // Current selection is not compatible with new backend, select first available
      setSelectedModel(filteredModels[0].path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useDirectML]);

  // Load models when setup is complete
  useEffect(() => {
    if (isSetupComplete) {
      loadModels();
      loadUninitializedModels();
    }
  }, [isSetupComplete, loadModels, loadUninitializedModels]);

  return {
    availableModels,
    uninitializedModels,
    selectedModel,
    setSelectedModel,
    filteredModels,
    loadModels,
    loadUninitializedModels,
  };
};
