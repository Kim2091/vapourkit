// src/hooks/useResizableColumn.ts - The settings column's width, dragged at its left edge.

import { useCallback, useEffect, useRef, useState } from 'react';

// Settings column drag bounds, in pixels.
const SETTINGS_MIN_W = 320;
const SETTINGS_MAX_W = 720;

/** The column's width in pixels, remembered across launches, and the handler that starts a drag. */
export function useResizableColumn() {
  // Settings column width — pixel-based drag on its left edge, persisted.
  // Pixels, not percentages: a proportional split is what stretched the
  // column to ~970px on a 2560px display.
  const [settingsWidth, setSettingsWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem('vk-settings-width'));
    return Number.isFinite(stored) && stored >= SETTINGS_MIN_W && stored <= SETTINGS_MAX_W ? stored : 400;
  });
  const [isResizingSettings, setIsResizingSettings] = useState(false);
  const resizeStartRef = useRef({ x: 0, width: 400 });

  const handleSettingsResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizeStartRef.current = { x: e.clientX, width: settingsWidth };
    setIsResizingSettings(true);
  }, [settingsWidth]);

  useEffect(() => {
    if (!isResizingSettings) return;
    const onMove = (e: MouseEvent) => {
      const delta = resizeStartRef.current.x - e.clientX;
      setSettingsWidth(Math.min(SETTINGS_MAX_W, Math.max(SETTINGS_MIN_W, resizeStartRef.current.width + delta)));
    };
    const onUp = () => setIsResizingSettings(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizingSettings]);

  useEffect(() => {
    if (!isResizingSettings) window.localStorage.setItem('vk-settings-width', String(settingsWidth));
  }, [settingsWidth, isResizingSettings]);

  return {
    width: settingsWidth,
    isResizing: isResizingSettings,
    handleResizeStart: handleSettingsResizeStart,
  };
}
