import { useState, useEffect, useCallback, useRef } from 'react';

export const useConsoleLog = () => {
  const [consoleOutput, setConsoleOutput] = useState<string[]>([]);
  const consoleEndRef = useRef<HTMLDivElement>(null);
  const lastLineCountRef = useRef<number>(0);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Manual log for UI-only messages (not persisted to file)
  const addConsoleLog = useCallback((message: string): void => {
    // UI-only logs are prefixed with timestamp
    // These are temporary and will be replaced when log file is polled
    setConsoleOutput(prev => {
      const newLog = `[${new Date().toLocaleTimeString()}] ${message}`;
      const updated = [...prev, newLog];
      return updated.length > 300 ? updated.slice(-300) : updated;
    });
  }, []);

  // Poll log file for updates - much more efficient than real-time IPC
  useEffect(() => {
    const pollLogFile = async () => {
      try {
        const result = await window.electronAPI.readLogTail(300);
        
        if (result.hasNewContent && result.lines.length > 0) {
          // Only update if content has actually changed
          // This prevents unnecessary re-renders
          if (result.lines.length !== lastLineCountRef.current || 
              result.lines[result.lines.length - 1] !== consoleOutput[consoleOutput.length - 1]) {
            lastLineCountRef.current = result.lines.length;
            setConsoleOutput(result.lines);
          }
        }
      } catch (error) {
        // Silently handle errors to avoid console spam
      }
    };

    // Initial load
    pollLogFile();

    // Poll every second - dramatically reduces IPC traffic compared to real-time
    pollIntervalRef.current = setInterval(pollLogFile, 1000);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, []); // Empty deps - only setup once

  // Auto-scroll console to bottom when new content arrives
  useEffect(() => {
    if (consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [consoleOutput]);

  return {
    consoleOutput,
    consoleEndRef,
    addConsoleLog,
  };
};
