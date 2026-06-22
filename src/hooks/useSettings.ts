import { useState, useEffect, useCallback } from 'react';
import type { GpuDevice } from '../electron.d';

export const useSettings = (hasCudaSupport: boolean | null) => {
  const [useDirectML, setUseDirectML] = useState(() => {
    const saved = localStorage.getItem('useDirectML');
    if (saved !== null) {
      return JSON.parse(saved);
    }
    return !hasCudaSupport;
  });

  const [numStreams, setNumStreams] = useState(() => {
    const saved = localStorage.getItem('numStreams');
    if (saved !== null) {
      return parseInt(saved, 10);
    }
    return 2;
  });

  const [deviceId, setDeviceId] = useState(() => {
    const saved = localStorage.getItem('deviceId');
    if (saved !== null) {
      return parseInt(saved, 10);
    }
    return 0;
  });

  const [availableGpus, setAvailableGpus] = useState<GpuDevice[]>([]);
  const [isEnumerating, setIsEnumerating] = useState(true);

  // Enumerate GPUs on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const gpus = await window.electronAPI.enumerateGpus();
        if (!cancelled) {
          setAvailableGpus(gpus);
        }
      } catch {
        // GPU enumeration failed silently
      } finally {
        if (!cancelled) {
          setIsEnumerating(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Validate deviceId after enumeration: fallback to primary GPU if saved ID no longer exists
  useEffect(() => {
    if (!isEnumerating && availableGpus.length > 0) {
      const isValid = availableGpus.some(gpu => gpu.index === deviceId);
      if (!isValid) {
        setDeviceId(availableGpus[0].index);
      }
    }
  }, [availableGpus, isEnumerating, deviceId]);

  // Update DirectML setting when CUDA support is detected
  useEffect(() => {
    if (hasCudaSupport !== null) {
      const saved = localStorage.getItem('useDirectML');
      if (saved === null) {
        const shouldUseDirectML = !hasCudaSupport;
        setUseDirectML(shouldUseDirectML);
        localStorage.setItem('useDirectML', JSON.stringify(shouldUseDirectML));
      }
    }
  }, [hasCudaSupport]);

  // Persist settings to localStorage
  useEffect(() => {
    localStorage.setItem('useDirectML', JSON.stringify(useDirectML));
  }, [useDirectML]);

  useEffect(() => {
    localStorage.setItem('numStreams', numStreams.toString());
  }, [numStreams]);

  useEffect(() => {
    localStorage.setItem('deviceId', deviceId.toString());
  }, [deviceId]);

  const toggleDirectML = useCallback((value: boolean): void => {
    setUseDirectML(value);
  }, []);

  const updateNumStreams = useCallback((value: number): void => {
    setNumStreams(value);
  }, []);

  const updateDeviceId = useCallback((value: number): void => {
    setDeviceId(value);
  }, []);

  return {
    useDirectML,
    toggleDirectML,
    numStreams,
    updateNumStreams,
    deviceId,
    updateDeviceId,
    availableGpus,
    isEnumerating,
  };
};
