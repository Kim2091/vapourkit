import { useState, useEffect } from 'react';
import type { Filter } from '../electron.d';
import { getErrorMessage } from '../types/errors';

export function useFilterConfig(
  isSetupComplete: boolean, 
  developerMode: boolean, 
  onLog: (message: string) => void
) {
  const [filters, setFilters] = useState<Filter[]>(() => {
    const saved = localStorage.getItem('filters');
    return saved !== null ? JSON.parse(saved) : [];
  });

  // Load filter configurations from backend
  useEffect(() => {
    const loadFilterConfigurations = async () => {
      try {
        const savedFilters = await window.electronAPI.getFilterConfigurations();
        if (savedFilters && savedFilters.length > 0) {
          // If not in developer mode, disable all filters to prevent errors
          const filtersToSet = developerMode 
            ? savedFilters 
            : savedFilters.map(f => ({ ...f, enabled: false }));
          setFilters(filtersToSet);
          onLog(`Loaded ${savedFilters.length} filter configuration(s)`);
          if (!developerMode && savedFilters.some(f => f.enabled)) {
            onLog('Filters disabled - simple mode active');
          }
        }
      } catch (error) {
        onLog(`Error loading filter configurations: ${getErrorMessage(error)}`);
      }
    };

    if (isSetupComplete) {
      loadFilterConfigurations();
    }
  }, [isSetupComplete, onLog, developerMode]);

  // Wrapper to persist state changes
  const handleSetFilters = (value: Filter[]) => {
    setFilters(value);
    localStorage.setItem('filters', JSON.stringify(value));
  };

  return {
    filters,
    setFilters,
    handleSetFilters,
  };
}
