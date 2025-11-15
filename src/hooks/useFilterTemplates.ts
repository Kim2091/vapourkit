// src/hooks/useFilterTemplates.ts
import { useState, useEffect, useCallback } from 'react';
import type { FilterTemplate } from '../electron.d';

export function useFilterTemplates(isSetupComplete: boolean = true) {
  const [templates, setTemplates] = useState<FilterTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load templates from backend
  const loadTemplates = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const loadedTemplates = await window.electronAPI.getFilterTemplates();
      setTemplates(loadedTemplates);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to load templates';
      setError(errorMsg);
      console.error('Error loading templates:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Save a new template
  const saveTemplate = useCallback(async (template: FilterTemplate): Promise<boolean> => {
    try {
      const result = await window.electronAPI.saveFilterTemplate(template);
      if (result.success) {
        await loadTemplates(); // Reload templates after saving
        return true;
      } else {
        setError(result.error || 'Failed to save template');
        return false;
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to save template';
      setError(errorMsg);
      console.error('Error saving template:', err);
      return false;
    }
  }, [loadTemplates]);

  // Delete a template
  const deleteTemplate = useCallback(async (name: string): Promise<boolean> => {
    try {
      const result = await window.electronAPI.deleteFilterTemplate(name);
      if (result.success) {
        await loadTemplates(); // Reload templates after deleting
        return true;
      } else {
        setError(result.error || 'Failed to delete template');
        return false;
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to delete template';
      setError(errorMsg);
      console.error('Error deleting template:', err);
      return false;
    }
  }, [loadTemplates]);

  // Load templates on mount
  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  // Reload templates when setup completes (new templates may be available)
  useEffect(() => {
    if (isSetupComplete) {
      loadTemplates();
    }
  }, [isSetupComplete, loadTemplates]);

  return {
    templates,
    isLoading,
    error,
    loadTemplates,
    saveTemplate,
    deleteTemplate,
  };
}