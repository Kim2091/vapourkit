import { useState, useEffect, useCallback } from 'react';
import type { SetupProgress } from '../electron.d';
import { getErrorMessage } from '../types/errors';

export function useSetup(onLog: (message: string) => void) {
  const [isSetupComplete, setIsSetupComplete] = useState(false);
  const [isCheckingDeps, setIsCheckingDeps] = useState(true);
  const [hasCudaSupport, setHasCudaSupport] = useState<boolean | null>(null);
  const [setupProgress, setSetupProgress] = useState<SetupProgress | null>(null);
  const [isSettingUp, setIsSettingUp] = useState(false);
  const [showPluginPrompt, setShowPluginPrompt] = useState(false);

  // Setup progress listener
  useEffect(() => {
    const unsubscribe = window.electronAPI.onSetupProgress((progress: SetupProgress) => {
      setSetupProgress(progress);
      onLog(`[Setup] ${progress.message} (${progress.progress}%)`);
      if (progress.type === 'complete') {
        setIsSetupComplete(true);
        setIsSettingUp(false);
        
        // Check if we should show the plugin prompt
        // Only show if this is the first time setup completed
        const hasShownPluginPrompt = localStorage.getItem('hasShownPluginPrompt');
        if (!hasShownPluginPrompt) {
          setShowPluginPrompt(true);
          localStorage.setItem('hasShownPluginPrompt', 'true');
          onLog('First-time setup complete - prompting for plugin installation');
        }
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
    
    // Clear all localStorage to prevent persistence issues from previous installations
    // but preserve any existing plugin prompt flag (shouldn't exist for first-time setups anyway)
    onLog('Clearing previous application data...');
    const hasShownPluginPrompt = localStorage.getItem('hasShownPluginPrompt');
    localStorage.clear();
    if (hasShownPluginPrompt) {
      localStorage.setItem('hasShownPluginPrompt', hasShownPluginPrompt);
    }
    
    onLog('Starting dependency setup...');
    await window.electronAPI.setupDependencies();
  };

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
    showPluginPrompt,
    setShowPluginPrompt,
  };
}
