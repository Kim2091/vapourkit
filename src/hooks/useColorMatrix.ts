import { useState, useEffect } from 'react';
import type { ColorMatrixSettings } from '../electron.d';
import { getErrorMessage } from '../types/errors';

export function useColorMatrix(isSetupComplete: boolean, onLog: (message: string) => void) {
  const [colorMatrixSettings, setColorMatrixSettings] = useState<ColorMatrixSettings>({
    overwriteMatrix: false,
    matrix709: false,
    defaultMatrix: '709',
    defaultPrimaries: '709',
    defaultTransfer: '709'
  });

  // Load color matrix settings
  useEffect(() => {
    const loadColorMatrixSettings = async () => {
      try {
        const settings = await window.electronAPI.getColorMatrixSettings();
        setColorMatrixSettings(settings);
        onLog('Color matrix settings loaded');
      } catch (error) {
        onLog(`Error loading color matrix settings: ${getErrorMessage(error)}`);
      }
    };

    if (isSetupComplete) {
      loadColorMatrixSettings();
    }
  }, [isSetupComplete, onLog]);

  const handleColorMatrixChange = async (settings: ColorMatrixSettings) => {
    setColorMatrixSettings(settings);
    try {
      await window.electronAPI.setColorMatrixSettings(settings);
      onLog(`Color matrix settings updated: ${settings.overwriteMatrix ? (settings.matrix709 ? 'BT.709' : 'BT.601') : 'disabled'}`);
    } catch (error) {
      onLog(`Error saving color matrix settings: ${getErrorMessage(error)}`);
    }
  };

  return {
    colorMatrixSettings,
    handleColorMatrixChange,
  };
}
