import { useState, useEffect, useCallback } from 'react';

export const useSettings = (hasCudaSupport: boolean | null) => {
  const [useDirectML, setUseDirectML] = useState(() => {
    const saved = localStorage.getItem('useDirectML');
    if (saved !== null) {
      return JSON.parse(saved);
    }
    // Default to false (use TensorRT) when CUDA is available
    return !hasCudaSupport;
  });

  const [numStreams, setNumStreams] = useState(() => {
    const saved = localStorage.getItem('numStreams');
    if (saved !== null) {
      return parseInt(saved, 10);
    }
    // Default to 2 streams for TensorRT
    return 2;
  });

  // Update DirectML setting when CUDA support is detected
  useEffect(() => {
    if (hasCudaSupport !== null) {
      const saved = localStorage.getItem('useDirectML');
      if (saved === null) {
        // First time initialization - set based on CUDA support
        const shouldUseDirectML = !hasCudaSupport;
        setUseDirectML(shouldUseDirectML);
        localStorage.setItem('useDirectML', JSON.stringify(shouldUseDirectML));
      }
    }
  }, [hasCudaSupport]);

  // Persist DirectML setting to localStorage
  useEffect(() => {
    localStorage.setItem('useDirectML', JSON.stringify(useDirectML));
  }, [useDirectML]);

  // Persist num_streams setting to localStorage
  useEffect(() => {
    localStorage.setItem('numStreams', numStreams.toString());
  }, [numStreams]);

  const toggleDirectML = useCallback((value: boolean): void => {
    setUseDirectML(value);
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
