import { useState, useEffect, useCallback } from 'react';
import { notify } from '../utils/notifications';

const STORAGE_KEY = 'privacyMode';

export const usePrivacyMode = () => {
  const [privacyMode, setPrivacyMode] = useState<boolean>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === 'true';
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(privacyMode));
    notify.setPrivacyMode(privacyMode);
  }, [privacyMode]);

  const togglePrivacyMode = useCallback((): void => {
    setPrivacyMode(prev => !prev);
  }, []);

  return { privacyMode, togglePrivacyMode };
};
