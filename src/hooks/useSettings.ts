import { useState, useEffect, useCallback } from 'react';
import type { BackendId } from '../electron.d';
import { isBackendId, resolveBackendId } from '../utils/backends';

/**
 * Reads the persisted default backend, migrating the legacy `useDirectML`
 * boolean key in place the first time it's seen.
 */
function readStoredBackend(): BackendId | null {
  const saved = localStorage.getItem('defaultBackend');
  if (saved !== null && isBackendId(saved)) {
    return saved;
  }

  const legacy = localStorage.getItem('useDirectML');
  if (legacy !== null) {
    try {
      const migrated = resolveBackendId(JSON.parse(legacy));
      localStorage.setItem('defaultBackend', migrated);
      localStorage.removeItem('useDirectML');
      return migrated;
    } catch {
      // Corrupt legacy value — fall through to first-run detection
    }
  }

  return null;
}

export const useSettings = (hasCudaSupport: boolean | null) => {
  const [defaultBackend, setDefaultBackendState] = useState<BackendId>(() => {
    // No saved preference yet — assume TensorRT until CUDA detection resolves.
    // The mount-time value of hasCudaSupport is always null (detection is an
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

  // First-time initialization once CUDA detection has resolved
  useEffect(() => {
    if (hasCudaSupport !== null) {
      if (readStoredBackend() === null) {
        const detected: BackendId = hasCudaSupport ? 'tensorrt' : 'directml';
        setDefaultBackendState(detected);
        localStorage.setItem('defaultBackend', detected);
      }
    }
  }, [hasCudaSupport]);

  // Persist num_streams setting to localStorage
  useEffect(() => {
    localStorage.setItem('numStreams', numStreams.toString());
  }, [numStreams]);

  const setDefaultBackend = useCallback((value: BackendId): void => {
    setDefaultBackendState(value);
    localStorage.setItem('defaultBackend', value);
  }, []);

  const updateNumStreams = useCallback((value: number): void => {
    setNumStreams(value);
  }, []);

  return {
    defaultBackend,
    setDefaultBackend,
    numStreams,
    updateNumStreams,
  };
};
