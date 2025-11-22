import { useState, useEffect, useCallback } from 'react';

export const useProcessingConfig = (isSetupComplete: boolean) => {
  const [ffmpegArgs, setFfmpegArgs] = useState<string>('');
  const [processingFormat, setProcessingFormat] = useState<string>('vs.YUV420P8');

  // Load configuration on mount
  useEffect(() => {
    const loadConfig = async (): Promise<void> => {
      try {
        const argsResult = await window.electronAPI.getFfmpegArgs();
        setFfmpegArgs(argsResult.args);
        
        const formatResult = await window.electronAPI.getProcessingFormat();
        setProcessingFormat(formatResult.format);
      } catch (error) {
        console.error('Failed to load processing config:', error);
      }
    };
    
    if (isSetupComplete) {
      loadConfig();
    }
  }, [isSetupComplete]);

  const handleUpdateFfmpegArgs = useCallback(async (args: string): Promise<void> => {
    try {
      setFfmpegArgs(args);
      await window.electronAPI.setFfmpegArgs(args);
    } catch (error) {
      console.error('Error updating FFmpeg args:', error);
    }
  }, []);

  const handleResetFfmpegArgs = useCallback(async (): Promise<void> => {
    try {
      const result = await window.electronAPI.getDefaultFfmpegArgs();
      setFfmpegArgs(result.args);
      await window.electronAPI.setFfmpegArgs(result.args);
    } catch (error) {
      console.error('Error resetting FFmpeg args:', error);
    }
  }, []);

  const handleUpdateProcessingFormat = useCallback(async (format: string): Promise<void> => {
    try {
      setProcessingFormat(format);
      await window.electronAPI.setProcessingFormat(format);
    } catch (error) {
      console.error('Error updating processing format:', error);
    }
  }, []);

  return {
    ffmpegArgs,
    processingFormat,
    handleUpdateFfmpegArgs,
    handleResetFfmpegArgs,
    handleUpdateProcessingFormat
  };
};
