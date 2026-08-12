import { useState, useEffect, useCallback } from 'react';
import type { BackendId } from '../electron.d';
import { isBackendId, normalizeBackendForCurrentPlatform } from '../utils/backends';

/**
 * Reads the persisted default backend, migrating the legacy `useDirectML`
 * boolean key in place the first time it's seen.
 */
function readStoredBackend(): BackendId | null {
  const saved = localStorage.getItem('defaultBackend');
  if (saved !== null && isBackendId(saved)) {
    const normalized = normalizeBackendForCurrentPlatform(saved);
    if (normalized !== saved) {
      localStorage.setItem('defaultBackend', normalized);
    }
    return normalized;
  }

  const legacy = localStorage.getItem('useDirectML');
  if (legacy !== null) {
    try {
      const migrated = normalizeBackendForCurrentPlatform(JSON.parse(legacy));
      localStorage.setItem('defaultBackend', migrated);
      localStorage.removeItem('useDirectML');
      return migrated;
    } catch {
      // Corrupt legacy value — fall through to first-run detection
    }
  }

  return null;
}

export const useSettings = (recommendedBackend: BackendId | null) => {
  const [defaultBackend, setDefaultBackendState] = useState<BackendId>(() => {
    // No saved preference yet — assume TensorRT until backend detection resolves.
    // The mount-time value of recommendedBackend is always null (detection is an
    // async IPC), so it must not influence the initial value, and nothing may
    // persist a guess to localStorage before detection completes (a persisted
    // guess would block the detection-based initialization below forever).
    return readStoredBackend() ?? 'tensorrt';
  });

  const [numStreams, setNumStreams] = useState(() => {
    const saved = localStorage.getItem('numStreams');
    if (saved !== null) {
      return parseInt(saved, 10);
    }
    // Default to 2 streams for TensorRT
    return 2;
  });

  // Whether the per-filter backend override control is shown in filter cards.
  // Off by default — most users only ever need the app-wide default backend.
  const [showBackendOverrides, setShowBackendOverridesState] = useState<boolean>(() => {
    return localStorage.getItem('showBackendOverrides') === 'true';
  });

  // First-time initialization once platform and GPU detection have resolved.
  useEffect(() => {
    if (recommendedBackend !== null) {
      if (readStoredBackend() === null) {
        setDefaultBackendState(recommendedBackend);
        localStorage.setItem('defaultBackend', recommendedBackend);
      }
    }
  }, [recommendedBackend]);

  // Persist num_streams setting to localStorage
  useEffect(() => {
    localStorage.setItem('numStreams', numStreams.toString());
  }, [numStreams]);

  const setDefaultBackend = useCallback((value: BackendId): void => {
    const normalized = normalizeBackendForCurrentPlatform(value);
    setDefaultBackendState(normalized);
    localStorage.setItem('defaultBackend', normalized);
  }, []);

  const updateNumStreams = useCallback((value: number): void => {
    setNumStreams(value);
  }, []);

  const setShowBackendOverrides = useCallback((value: boolean): void => {
    setShowBackendOverridesState(value);
    localStorage.setItem('showBackendOverrides', String(value));
  }, []);

  return {
    defaultBackend,
    setDefaultBackend,
    numStreams,
    updateNumStreams,
    showBackendOverrides,
    setShowBackendOverrides,
  };
};
