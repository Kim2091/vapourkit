import { useState, useEffect, useCallback } from 'react';
import { getErrorMessage } from '../types/errors';

interface PanelSizes {
  leftPanel: number;
  rightPanel: number;
}

export function usePanelLayout(isSetupComplete: boolean, onLog: (message: string) => void) {
  const [panelSizes, setPanelSizes] = useState<PanelSizes>({ leftPanel: 50, rightPanel: 50 });
  const [panelSizesLoaded, setPanelSizesLoaded] = useState(false);

  // Load panel sizes from backend
  useEffect(() => {
    const loadPanelSizes = async () => {
      try {
        const sizes = await window.electronAPI.getPanelSizes();
        setPanelSizes(sizes);
        setPanelSizesLoaded(true);
      } catch (error) {
        onLog(`Error loading panel sizes: ${getErrorMessage(error)}`);
        setPanelSizesLoaded(true); // Still mark as loaded even on error
      }
    };

    if (isSetupComplete) {
      loadPanelSizes();
    }
  }, [isSetupComplete, onLog]);

  // Save panel sizes when they change (with debouncing)
  const handlePanelResize = useCallback((sizes: number[]) => {
    const [leftPanel, rightPanel] = sizes;
    const newSizes = { leftPanel, rightPanel };
    setPanelSizes(newSizes);
    
    // Debounce the save operation
    const timeoutId = setTimeout(async () => {
      try {
        await window.electronAPI.setPanelSizes(newSizes);
      } catch (error) {
        onLog(`Error saving panel sizes: ${getErrorMessage(error)}`);
      }
    }, 500);
    
    return () => clearTimeout(timeoutId);
  }, [onLog]);

  return {
    panelSizes,
    panelSizesLoaded,
    handlePanelResize,
  };
}
