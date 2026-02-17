import { useState, useEffect, useCallback } from 'react';
import type { ModelFile, UninitializedModel } from '../electron.d';

interface StoredRecentModel {
  path?: string;
  lastUsed?: number;
}

const RECENT_MODELS_KEY = 'vapourkit_recent_models';

function getMostRecentAvailableModel(models: ModelFile[]): string | null {
  if (models.length === 0) return null;

  try {
    const stored = localStorage.getItem(RECENT_MODELS_KEY);
    if (!stored) return null;

    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) return null;

    const recent = parsed
      .map(item => {
        if (typeof item === 'string') return { path: item, lastUsed: 0 };
        const obj = item as StoredRecentModel;
        return {
          path: typeof obj?.path === 'string' ? obj.path : '',
          lastUsed: typeof obj?.lastUsed === 'number' ? obj.lastUsed : 0,
        };
      })
      .filter(item => !!item.path)
      .sort((a, b) => b.lastUsed - a.lastUsed);

    const firstAvailable = recent.find(item => models.some(model => model.path === item.path));
    return firstAvailable?.path || null;
  } catch {
    return null;
  }
}

export const useModels = (isSetupComplete: boolean) => {
  const [availableModels, setAvailableModels] = useState<ModelFile[]>([]);
  const [uninitializedModels, setUninitializedModels] = useState<UninitializedModel[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);

  const loadModels = useCallback(async (): Promise<void> => {
    try {
      const models = await window.electronAPI.getAvailableModels();
      setAvailableModels(models);
      // Use functional updater to avoid dependency on selectedModel
      setSelectedModel(prev => {
        // If no model selected yet and we have models, prefer most recent model first
        if (prev === null && models.length > 0) {
          const recentModel = getMostRecentAvailableModel(models);
          if (recentModel) {
            return recentModel;
          }
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
