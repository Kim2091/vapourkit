import { useState } from 'react';

export function useUIState() {
  const [showPreview, setShowPreviewRaw] = useState(() => localStorage.getItem('showPreview') !== 'false');
  const setShowPreview = (show: boolean) => {
    setShowPreviewRaw(show);
    localStorage.setItem('showPreview', String(show));
  };
  const [showConsole, setShowConsole] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showPlugins, setShowPlugins] = useState(false);
  const [showVideoInfo, setShowVideoInfo] = useState(() => {
    const saved = localStorage.getItem('showVideoInfo');
    return saved !== null ? JSON.parse(saved) : true;
  });
  const [isReloading, setIsReloading] = useState(false);

  const handleToggleVideoInfo = (newValue: boolean) => {
    setShowVideoInfo(newValue);
    localStorage.setItem('showVideoInfo', JSON.stringify(newValue));
  };

  return {
    showPreview,
    setShowPreview,
    showConsole,
    setShowConsole,
    showAbout,
    setShowAbout,
    showSettings,
    setShowSettings,
    showPlugins,
    setShowPlugins,
    showVideoInfo,
    handleToggleVideoInfo,
    isReloading,
    setIsReloading,
  };
}
