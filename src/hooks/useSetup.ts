import { useState, useEffect, useCallback } from 'react';
import type { BackendId, InstallFailureInfo, InstallResult, SetupProgress } from '../electron.d';
import { getErrorMessage } from '../types/errors';

/** The sentence up front, the evidence for "Details"; falls back to the one-string forms. */
function failureFrom(source: SetupProgress | InstallResult, fallback: string): InstallFailureInfo {
  const summary = source.summary
    ?? ('message' in source ? source.message : source.error)
    ?? fallback;
  return { summary, evidence: source.evidence, logPath: source.logPath };
}

export function useSetup(onLog: (message: string) => void) {
  const [isSetupComplete, setIsSetupComplete] = useState(false);
  const [isCheckingDeps, setIsCheckingDeps] = useState(true);
  const [hasCudaSupport, setHasCudaSupport] = useState<boolean | null>(null);
  const [recommendedBackend, setRecommendedBackend] = useState<BackendId | null>(null);
  const [setupProgress, setSetupProgress] = useState<SetupProgress | null>(null);
  const [isSettingUp, setIsSettingUp] = useState(false);
  const [pluginInstallError, setPluginInstallError] = useState<InstallFailureInfo | null>(null);
  const [setupError, setSetupError] = useState<InstallFailureInfo | null>(null);
  const [setupWarnings, setSetupWarnings] = useState<string[]>([]);

  // Setup progress listener
  useEffect(() => {
    const unsubscribe = window.electronAPI.onSetupProgress((progress: SetupProgress) => {
      onLog(`[Setup] ${progress.message} (${progress.progress}%)`);

      // A warning stops nothing, so it must not move the step list; it is
      // kept on screen instead of being overwritten by the next message.
      if (progress.type === 'warning') {
        setSetupWarnings(previous => previous.includes(progress.message) ? previous : [...previous, progress.message]);
        return;
      }

      setSetupProgress(progress);

      if (progress.type === 'error' && progress.component.startsWith('Plugins')) {
        // Only sent once the installer's automatic retry has failed too (a
        // retry in progress arrives as 'retrying'), so the recovery buttons
        // are enabled only when no install is running.
        setPluginInstallError(failureFrom(progress, 'The plugin install failed.'));
        setIsSettingUp(false);
        return;
      }

      if (progress.type === 'error' && progress.component === 'Setup') {
        // Core setup stopped. Without this "Start Setup" stayed disabled with
        // a spinner until the app was restarted.
        setSetupError(failureFrom(progress, 'Setup failed.'));
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
      const inferenceInfo = await window.electronAPI.getInferenceBackendInfo();
      setHasCudaSupport(inferenceInfo.hasCudaSupport);
      setRecommendedBackend(inferenceInfo.backend);
      onLog(`CUDA support: ${inferenceInfo.hasCudaSupport ? 'detected' : 'not detected'}; recommended backend: ${inferenceInfo.backend}`);

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
    setSetupError(null);
    setSetupWarnings([]);

    // Clear localStorage to prevent persistence issues from previous installations.
    onLog('Clearing previous application data...');
    localStorage.clear();

    onLog('Starting dependency setup...');
    // The progress events drive the screen; the reply is acted on as well so
    // a failure still unlocks the screen if its event was missed.
    try {
      const result = await window.electronAPI.setupDependencies();
      if (result.success) {
        setIsSetupComplete(true);
        setIsSettingUp(false);
        return;
      }
      if (result.alreadyRunning) {
        onLog('Setup is already running');
        return;
      }
      if (result.phase === 'plugins') {
        setPluginInstallError(previous => previous ?? failureFrom(result, 'The plugin install failed.'));
      } else {
        setSetupError(previous => previous ?? failureFrom(result, 'Setup failed.'));
      }
      setIsSettingUp(false);
    } catch (error) {
      setSetupError({ summary: getErrorMessage(error) });
      setIsSettingUp(false);
    }
  };

  const handleRetryPlugins = useCallback(async (): Promise<void> => {
    setIsSettingUp(true);
    setPluginInstallError(null);
    onLog('Retrying plugin install...');
    try {
      const result = await window.electronAPI.retrySetupPlugins();
      if (result.success) {
        setIsSetupComplete(true);
        setIsSettingUp(false);
        return;
      }
      if (result.alreadyRunning) {
        // The install that is running reports through the progress events.
        onLog(result.summary ?? 'A plugin install is already running');
        return;
      }
      setPluginInstallError(previous => previous ?? failureFrom(result, 'The plugin install failed.'));
      setIsSettingUp(false);
    } catch (error) {
      setPluginInstallError({ summary: getErrorMessage(error) });
      setIsSettingUp(false);
    }
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
    recommendedBackend,
    setupProgress,
    isSettingUp,
    handleSetup,
    pluginInstallError,
    setupError,
    setupWarnings,
    handleRetryPlugins,
    handleContinueWithoutPlugins,
  };
}
