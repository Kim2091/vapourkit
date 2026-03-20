// src/hooks/useAppEffects.ts - Standalone side effects extracted from App.tsx

import { useEffect, useCallback } from 'react';
import { notify } from '../utils/notifications';
import { getErrorMessage } from '../types/errors';
import type { UpdateInfo, VsMlrtVersionInfo } from '../electron';

interface UseAppEffectsOptions {
  isSetupComplete: boolean;
  hasCudaSupport: boolean | null;
  previewFrame: string | null;
  rightPanelRef: React.RefObject<HTMLDivElement>;
  addConsoleLog: (message: string) => void;
  setUpdateInfo: (info: UpdateInfo) => void;
  setShowUpdateModal: (show: boolean) => void;
  setVsMlrtVersionInfo: (info: VsMlrtVersionInfo) => void;
  setShowVsMlrtModal: (show: boolean) => void;
}

export function useAppEffects({
  isSetupComplete,
  hasCudaSupport,
  previewFrame,
  rightPanelRef,
  addConsoleLog,
  setUpdateInfo,
  setShowUpdateModal,
  setVsMlrtVersionInfo,
  setShowVsMlrtModal,
}: UseAppEffectsOptions) {
  // Preserve scroll position in right panel when preview updates
  useEffect(() => {
    const rightPanel = rightPanelRef.current;
    if (rightPanel) {
      const scrollTop = rightPanel.scrollTop;
      requestAnimationFrame(() => {
        rightPanel.scrollTop = scrollTop;
      });
    }
  }, [previewFrame]);

  // Check for updates on startup
  useEffect(() => {
    const checkForUpdates = async (): Promise<void> => {
      try {
        const result = await window.electronAPI.checkForUpdates();
        if (result.success && result.data && result.data.available) {
          setUpdateInfo(result.data);
          setShowUpdateModal(true);
          addConsoleLog(`Update available: ${result.data.latestVersion}`);
        } else {
          addConsoleLog('No updates available');
        }
      } catch (error) {
        console.error('Failed to check for updates:', error);
      }
    };

    if (isSetupComplete) {
      const timeoutId = setTimeout(checkForUpdates, 2000);
      return () => clearTimeout(timeoutId);
    }
  }, [isSetupComplete, addConsoleLog, setUpdateInfo, setShowUpdateModal]);

  // Check for vs-mlrt version mismatch on startup
  useEffect(() => {
    const checkVsMlrtVersion = async (): Promise<void> => {
      try {
        const versionInfo = await window.electronAPI.checkVsMlrtVersion();

        if (versionInfo.needsNotification) {
          addConsoleLog(`vs-mlrt version upgrade detected: ${versionInfo.storedVersion || 'unknown'} → ${versionInfo.currentVersion}`);
          setVsMlrtVersionInfo(versionInfo);
          setShowVsMlrtModal(true);
        } else if (versionInfo.storedVersion === undefined && versionInfo.engineCount > 0) {
          addConsoleLog(`vs-mlrt version upgrade detected (${versionInfo.engineCount} engine(s) from previous version may need rebuilding)`);
          setVsMlrtVersionInfo(versionInfo);
          setShowVsMlrtModal(true);
        } else if (versionInfo.hasVersionMismatch) {
          addConsoleLog(`vs-mlrt version mismatch detected: ${versionInfo.storedVersion} → ${versionInfo.currentVersion}`);
          setVsMlrtVersionInfo(versionInfo);
          setShowVsMlrtModal(true);
        } else if (versionInfo.storedVersion === undefined) {
          await window.electronAPI.updateVsMlrtVersion();
          addConsoleLog(`vs-mlrt version initialized: ${versionInfo.currentVersion}`);
        } else {
          addConsoleLog(`vs-mlrt version: ${versionInfo.currentVersion}`);
        }
      } catch (error) {
        console.error('Failed to check vs-mlrt version:', error);
        addConsoleLog(`Error checking vs-mlrt version: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    };

    if (isSetupComplete && hasCudaSupport) {
      checkVsMlrtVersion();
    }
  }, [isSetupComplete, hasCudaSupport, addConsoleLog, setVsMlrtVersionInfo, setShowVsMlrtModal]);

  // Global error handlers
  useEffect(() => {
    const handleError = (event: ErrorEvent): void => {
      event.preventDefault();
      const message = getErrorMessage(event.error || event.message);
      notify.error('Error', message);
    };

    const handleRejection = (event: PromiseRejectionEvent): void => {
      event.preventDefault();
      const message = getErrorMessage(event.reason);
      notify.error('Error', message);
    };

    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleRejection);

    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleRejection);
    };
  }, []);

  // Focus recovery mechanism for Electron/Chromium focus desync issues
  useEffect(() => {
    let focusRecoveryPending = false;

    const handleInteraction = (e: Event) => {
      if (focusRecoveryPending) return;

      const target = e.target as HTMLElement;

      if (target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      )) {
        return;
      }

      requestAnimationFrame(() => {
        const activeElement = document.activeElement;

        if (!activeElement || activeElement === document.body || activeElement === document.documentElement) {
          if (target && target.closest) {
            const focusable = target.closest('button, a, [tabindex]:not([tabindex="-1"])');
            if (focusable instanceof HTMLElement) {
              focusRecoveryPending = true;
              focusable.focus({ preventScroll: true });
              focusRecoveryPending = false;
              return;
            }
          }

          window.focus();
        }
      });
    };

    const handleWindowBlur = () => {};

    const handleWindowFocus = () => {
      requestAnimationFrame(() => {
        const activeElement = document.activeElement;
        if (!activeElement || activeElement === document.body || activeElement === document.documentElement) {
          const mainContent = document.querySelector('main') || document.querySelector('[role="main"]');
          if (mainContent instanceof HTMLElement) {
            mainContent.focus({ preventScroll: true });
          }
        }
      });
    };

    document.addEventListener('mousedown', handleInteraction, { passive: true, capture: true });
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('focus', handleWindowFocus);

    return () => {
      document.removeEventListener('mousedown', handleInteraction, true);
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, []);

  // Helper to restore focus after modal closes
  const closeModalWithFocusRestore = useCallback((closeFn: () => void) => {
    closeFn();
    requestAnimationFrame(() => {
      const mainContent = document.querySelector('main') || document.body;
      if (mainContent instanceof HTMLElement) {
        mainContent.focus({ preventScroll: true });
      }
      window.focus();
    });
  }, []);

  return { closeModalWithFocusRestore };
}
