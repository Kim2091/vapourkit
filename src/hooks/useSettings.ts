import { useState, useCallback } from 'react';

/**
 * Display preferences. The default backend and stream count are workflow
 * settings (useWorkflowDocument).
 */
export const useSettings = () => {
  // Whether the per-filter backend override control is shown in filter cards.
  // Off by default — most users only ever need the app-wide default backend.
  const [showBackendOverrides, setShowBackendOverridesState] = useState<boolean>(() => {
    return localStorage.getItem('showBackendOverrides') === 'true';
  });

  const setShowBackendOverrides = useCallback((value: boolean): void => {
    setShowBackendOverridesState(value);
    localStorage.setItem('showBackendOverrides', String(value));
  }, []);

  return {
    showBackendOverrides,
    setShowBackendOverrides,
  };
};
