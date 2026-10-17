import { useState, useEffect, useCallback } from 'react';

/**
 * App settings for how outputs are named. The encoding settings they sit
 * beside in app-config.json belong to the workflow (useWorkflowDocument).
 */
export const useProcessingConfig = (isSetupComplete: boolean) => {
  const [defaultOutputFolder, setDefaultOutputFolder] = useState<string | null>(null);
  const [descriptiveNamingEnabled, setDescriptiveNamingEnabled] = useState<boolean>(true);

  useEffect(() => {
    if (!isSetupComplete) return;
    const loadConfig = async (): Promise<void> => {
      try {
        const defaultFolderResult = await window.electronAPI.getDefaultOutputFolder();
        setDefaultOutputFolder(defaultFolderResult.folder);

        const descriptiveNamingResult = await window.electronAPI.getDescriptiveNamingEnabled();
        setDescriptiveNamingEnabled(descriptiveNamingResult.enabled);
      } catch (error) {
        console.error('Failed to load processing config:', error);
      }
    };
    loadConfig();
  }, [isSetupComplete]);

  const handleUpdateDefaultOutputFolder = useCallback(async (folder: string | null): Promise<void> => {
    try {
      setDefaultOutputFolder(folder);
      await window.electronAPI.setDefaultOutputFolder(folder);
    } catch (error) {
      console.error('Error updating default output folder:', error);
    }
  }, []);

  const handleResetDefaultOutputFolder = useCallback(async (): Promise<void> => {
    try {
      setDefaultOutputFolder(null);
      await window.electronAPI.setDefaultOutputFolder(null);
    } catch (error) {
      console.error('Error resetting default output folder:', error);
    }
  }, []);

  const handleUpdateDescriptiveNamingEnabled = useCallback(async (enabled: boolean): Promise<void> => {
    try {
      setDescriptiveNamingEnabled(enabled);
      await window.electronAPI.setDescriptiveNamingEnabled(enabled);
    } catch (error) {
      console.error('Error updating descriptive naming setting:', error);
    }
  }, []);

  return {
    defaultOutputFolder,
    descriptiveNamingEnabled,
    handleUpdateDefaultOutputFolder,
    handleResetDefaultOutputFolder,
    handleUpdateDescriptiveNamingEnabled,
  };
};
