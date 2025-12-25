import { useState, useEffect, useCallback, useRef } from 'react';

export const useConsoleLog = () => {
  const [consoleOutput, setConsoleOutput] = useState<string[]>([]);
  const consoleEndRef = useRef<HTMLDivElement>(null);
  const lastLineRef = useRef<string>('');
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
          const newLastLine = result.lines[result.lines.length - 1];
          // Only update if the last line has actually changed
          // Use a ref to avoid stale closure issues
          if (newLastLine !== lastLineRef.current) {
            lastLineRef.current = newLastLine;
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
  // Debounced with 'auto' behavior to prevent continuous animations
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  useEffect(() => {
    // Clear any pending scroll
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }
    
    // Debounce scrolling to prevent excessive DOM reflows
    scrollTimeoutRef.current = setTimeout(() => {
      if (consoleEndRef.current) {
        consoleEndRef.current.scrollIntoView({ behavior: 'auto' });
      }
    }, 100);
    
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, [consoleOutput]);

  return {
    consoleOutput,
    consoleEndRef,
    addConsoleLog,
  };
};
