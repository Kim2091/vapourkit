import { useState, useEffect, useCallback, useRef } from 'react';

interface DevConsoleLog {
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
}

export const useDeveloperMode = () => {
  const [developerMode, setDeveloperMode] = useState(false);
  const [isDeveloperModeLoaded, setIsDeveloperModeLoaded] = useState(false);
  const [consoleOutput, setConsoleOutput] = useState<string[]>([]);
  const consoleEndRef = useRef<HTMLDivElement>(null);

  const addConsoleLog = useCallback((message: string): void => {
    setConsoleOutput(prev => {
      const newLog = `[${new Date().toLocaleTimeString()}] ${message}`;
      const updated = [...prev, newLog];
      // Keep only the last 300 lines
      return updated.length > 300 ? updated.slice(-300) : updated;
    });
  }, []);

  // Initialize developer mode
  useEffect(() => {
    const loadDeveloperMode = async (): Promise<void> => {
      try {
        const result = await window.electronAPI.getDeveloperMode();
        setDeveloperMode(result.enabled);
      } catch (error) {
        console.error('Error loading developer mode:', error);
      } finally {
        setIsDeveloperModeLoaded(true);
      }
    };
    loadDeveloperMode();

    // Listen for developer console logs
    const unsubscribe = window.electronAPI.onDevConsoleLog((log: DevConsoleLog) => {
      const levelPrefix = log.level === 'error' ? '❌' : 
                         log.level === 'warn' ? '⚠️' : 
                         log.level === 'debug' ? '🔍' : 'ℹ️';
      addConsoleLog(`${levelPrefix} [${log.level.toUpperCase()}] ${log.message}`);
    });

    return () => {
      // Cleanup listener if the API provides an unsubscribe method
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [addConsoleLog]);

  // Auto-scroll console to bottom
  useEffect(() => {
    if (consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [consoleOutput]);

  const toggleDeveloperMode = useCallback(async (enabled: boolean): Promise<void> => {
    try {
      await window.electronAPI.setDeveloperMode(enabled);
      setDeveloperMode(enabled);
    } catch (error) {
      console.error('Error setting developer mode:', error);
    }
  }, []);

  return {
    developerMode,
    isDeveloperModeLoaded,
    consoleOutput,
    consoleEndRef,
    addConsoleLog,
    toggleDeveloperMode,
  };
};
