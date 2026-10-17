import { useState, useEffect, useCallback, useRef } from 'react';
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

/** The model to select once models: the current one if it is still there, else the most recent, else the first. */
function modelToSelect(current: string | null, models: ModelFile[]): string | null {
  if (models.length === 0) return null;
  if (current === null) return getMostRecentAvailableModel(models) ?? models[0].path;
  if (current && !models.some(m => m.path === current)) return models[0].path;
  return current;
}

/**
 * The models on disk. The selected model is a workflow setting, read and set
 * through selection, which is kept valid as the list changes.
 */
export const useModels = (
  isSetupComplete: boolean,
  selection: { get: () => string | null; set: (model: string | null) => void },
) => {
  const [availableModels, setAvailableModels] = useState<ModelFile[]>([]);
  const [uninitializedModels, setUninitializedModels] = useState<UninitializedModel[]>([]);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const loadModels = useCallback(async (): Promise<void> => {
    try {
      const models = await window.electronAPI.getAvailableModels();
      setAvailableModels(models);
      const current = selectionRef.current.get();
      const next = modelToSelect(current, models);
      if (next !== current) selectionRef.current.set(next);
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
    loadModels,
    loadUninitializedModels,
  };
};
