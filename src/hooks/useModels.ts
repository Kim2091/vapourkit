import { useState, useEffect, useCallback } from 'react';
import type { ModelFile, UninitializedModel } from '../electron.d';

const RECENT_MODELS_KEY = 'vapourkit_recent_models';

export const useModels = (isSetupComplete: boolean) => {
  const [availableModels, setAvailableModels] = useState<ModelFile[]>([]);
  const [uninitializedModels, setUninitializedModels] = useState<UninitializedModel[]>([]);
  const [selectedModel, setSelectedModelState] = useState<string | null>(null);

  const setSelectedModel = useCallback((model: string | null) => {
    setSelectedModelState(model);
    void window.electronAPI.setLastSelectedModelPath(model);
  }, []);

  const loadModels = useCallback(async (): Promise<void> => {
    try {
      const models = await window.electronAPI.getAvailableModels();
      const { modelPath: lastSelectedModelPath } = await window.electronAPI.getLastSelectedModelPath();
      setAvailableModels(models);

      const hasCurrentSelection = selectedModel
        ? models.some(m => m.path === selectedModel)
        : false;

      if (hasCurrentSelection) {
        return;
      }

      const hasSavedSelection = !!lastSelectedModelPath && models.some(m => m.path === lastSelectedModelPath);
      if (hasSavedSelection) {
        setSelectedModelState(lastSelectedModelPath);
        return;
      }

      if (lastSelectedModelPath) {
        localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify([]));
        await window.electronAPI.setLastSelectedModelPath(null);
      }

      setSelectedModelState(null);
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
    loadModels,
    loadUninitializedModels,
  };
};
