import { useState, useEffect, useCallback } from 'react';

export const useSettings = (hasCudaSupport: boolean | null) => {
  const [useDirectML, setUseDirectML] = useState(() => {
    const saved = localStorage.getItem('useDirectML');
    if (saved !== null) {
      return JSON.parse(saved);
    }
    // No saved preference yet — assume TensorRT until CUDA detection resolves.
    // The mount-time value of hasCudaSupport is always null (detection is an
    // async IPC), so it must not influence the initial value, and nothing may
    // persist a guess to localStorage before detection completes (a persisted
    // guess would block the detection-based initialization below forever).
    return false;
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
      const saved = localStorage.getItem('useDirectML');
      if (saved === null) {
        const shouldUseDirectML = !hasCudaSupport;
        setUseDirectML(shouldUseDirectML);
        localStorage.setItem('useDirectML', JSON.stringify(shouldUseDirectML));
      }
    }
  }, [hasCudaSupport]);

  // Persist num_streams setting to localStorage
  useEffect(() => {
    localStorage.setItem('numStreams', numStreams.toString());
  }, [numStreams]);

  const toggleDirectML = useCallback((value: boolean): void => {
    setUseDirectML(value);
    localStorage.setItem('useDirectML', JSON.stringify(value));
  }, []);

  const updateNumStreams = useCallback((value: number): void => {
    setNumStreams(value);
  }, []);

  return {
    useDirectML,
    toggleDirectML,
    numStreams,
    updateNumStreams,
  };
};
