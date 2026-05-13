import { useState, useEffect, useCallback } from 'react';
import type { SetupProgress } from '../electron.d';
import { getErrorMessage } from '../types/errors';

export function useSetup(onLog: (message: string) => void) {
  const [isSetupComplete, setIsSetupComplete] = useState(false);
  const [isCheckingDeps, setIsCheckingDeps] = useState(true);
  const [hasCudaSupport, setHasCudaSupport] = useState<boolean | null>(null);
  const [setupProgress, setSetupProgress] = useState<SetupProgress | null>(null);
  const [isSettingUp, setIsSettingUp] = useState(false);
  const [pluginInstallError, setPluginInstallError] = useState<string | null>(null);

  // Setup progress listener
  useEffect(() => {
    const unsubscribe = window.electronAPI.onSetupProgress((progress: SetupProgress) => {
      setSetupProgress(progress);
      onLog(`[Setup] ${progress.message} (${progress.progress}%)`);

      if (progress.type === 'error' && progress.component.startsWith('Plugins')) {
        // Plugin install error after the installer's internal auto-retry.
        // Keep isSettingUp false so the recovery buttons are enabled; surface
        // the error in dedicated state so SetupScreen renders the recovery UI.
        setPluginInstallError(progress.message);
        setIsSettingUp(false);
        return;
      }

      if (progress.type === 'complete' && progress.component === 'All Dependencies') {
        setIsSetupComplete(true);
        setIsSettingUp(false);
        setPluginInstallError(null);
      }
    });

    return unsubscribe;
  }, [onLog]);

  const checkDependencies = useCallback(async (): Promise<void> => {
    setIsCheckingDeps(true);
    try {
      const cudaSupport = await window.electronAPI.detectCudaSupport();
      setHasCudaSupport(cudaSupport);
      onLog(`CUDA support: ${cudaSupport ? 'detected' : 'not detected'}`);

      const isComplete = await window.electronAPI.checkDependencies();
      setIsSetupComplete(isComplete);
      if (!isComplete) {
        onLog('Dependencies not found - setup required');
      } else {
        onLog('All dependencies present');
      }
    } catch (error) {
      onLog(`Error checking dependencies: ${getErrorMessage(error)}`);
    } finally {
      setIsCheckingDeps(false);
    }
  }, [onLog]);

  const handleSetup = async (): Promise<void> => {
    setIsSettingUp(true);
    setPluginInstallError(null);

    // Clear localStorage to prevent persistence issues from previous installations.
    onLog('Clearing previous application data...');
    localStorage.clear();

    onLog('Starting dependency setup...');
    await window.electronAPI.setupDependencies();
  };

  const handleRetryPlugins = useCallback(async (): Promise<void> => {
    setIsSettingUp(true);
    setPluginInstallError(null);
    onLog('Retrying plugin install...');
    await window.electronAPI.retrySetupPlugins();
  }, [onLog]);

  const handleContinueWithoutPlugins = useCallback((): void => {
    onLog('User chose to continue without plugins - entering main app');
    setPluginInstallError(null);
    setIsSettingUp(false);
    setIsSetupComplete(true);
  }, [onLog]);

  // Check dependencies on mount
  useEffect(() => {
    checkDependencies();
  }, [checkDependencies]);

  return {
    isSetupComplete,
    isCheckingDeps,
    hasCudaSupport,
    setupProgress,
    isSettingUp,
    handleSetup,
    pluginInstallError,
    handleRetryPlugins,
    handleContinueWithoutPlugins,
  };
}
