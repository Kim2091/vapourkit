import { useState, useEffect, useCallback, useMemo } from 'react';
import type { ModelFile, UninitializedModel } from '../electron.d';
import { filterModels, isModelStillValid } from '../utils/modelUtils';

export const useModels = (isSetupComplete: boolean, useDirectML: boolean, advancedMode: boolean) => {
  const [availableModels, setAvailableModels] = useState<ModelFile[]>([]);
  const [uninitializedModels, setUninitializedModels] = useState<UninitializedModel[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);

  const loadModels = useCallback(async (): Promise<void> => {
    try {
      const models = await window.electronAPI.getAvailableModels();
      setAvailableModels(models);
      if (models.length > 0 && selectedModel === null) {
        setSelectedModel(models[0].path);
      }
    } catch (error) {
      console.error('Error loading models:', error);
    }
  }, [selectedModel]);

  const loadUninitializedModels = useCallback(async (): Promise<void> => {
    try {
      const models = await window.electronAPI.getUninitializedModels();
      setUninitializedModels(models);
    } catch (error) {
      console.error('Error loading uninitialized models:', error);
    }
  }, []);

  // Filter models based on DirectML setting and advanced mode
  const filteredModels = useMemo(() => {
    return filterModels(availableModels, useDirectML, advancedMode);
  }, [availableModels, useDirectML, advancedMode]);

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
