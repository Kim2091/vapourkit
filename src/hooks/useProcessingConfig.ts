import { useState, useEffect, useCallback } from 'react';

export const useProcessingConfig = (isSetupComplete: boolean) => {
  const [ffmpegArgs, setFfmpegArgs] = useState<string>('');
  const [processingFormat, setProcessingFormat] = useState<string>('vs.YUV420P8');
  const [outputFormat, setOutputFormat] = useState<string>('mkv');
  const [videoCompareArgs, setVideoCompareArgs] = useState<string>('-W');
  const [defaultOutputFolder, setDefaultOutputFolder] = useState<string | null>(null);
  const [descriptiveNamingEnabled, setDescriptiveNamingEnabled] = useState<boolean>(true);

  // Load configuration on mount
  useEffect(() => {
    const loadConfig = async (): Promise<void> => {
      try {
        const argsResult = await window.electronAPI.getFfmpegArgs();
        setFfmpegArgs(argsResult.args);

        const formatResult = await window.electronAPI.getProcessingFormat();
        setProcessingFormat(formatResult.format);

        const outputFormatResult = await window.electronAPI.getOutputFormat();
        setOutputFormat(outputFormatResult.format);

        const videoCompareResult = await window.electronAPI.getVideoCompareArgs();
        setVideoCompareArgs(videoCompareResult.args);

        const defaultFolderResult = await window.electronAPI.getDefaultOutputFolder();
        setDefaultOutputFolder(defaultFolderResult.folder);

        const descriptiveNamingResult = await window.electronAPI.getDescriptiveNamingEnabled();
        setDescriptiveNamingEnabled(descriptiveNamingResult.enabled);
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

  const handleUpdateVideoCompareArgs = useCallback(async (args: string): Promise<void> => {
    try {
      setVideoCompareArgs(args);
      await window.electronAPI.setVideoCompareArgs(args);
    } catch (error) {
      console.error('Error updating video compare args:', error);
    }
  }, []);

  const handleResetVideoCompareArgs = useCallback(async (): Promise<void> => {
    try {
      const result = await window.electronAPI.getDefaultVideoCompareArgs();
      setVideoCompareArgs(result.args);
      await window.electronAPI.setVideoCompareArgs(result.args);
    } catch (error) {
      console.error('Error resetting video compare args:', error);
    }
  }, []);

  const handleUpdateDefaultOutputFolder = useCallback(async (folder: string | null): Promise<void> => {
    try {
      setDefaultOutputFolder(folder);
      await window.electronAPI.setDefaultOutputFolder(folder);
    } catch (error) {
      console.error('Error updating default output folder:', error);
    }
  }, []);

  const handleResetDefaultOutputFolder = useCallback(async (): Promise<void> => {
    try {
      setDefaultOutputFolder(null);
      await window.electronAPI.setDefaultOutputFolder(null);
    } catch (error) {
      console.error('Error resetting default output folder:', error);
    }
  }, []);

  const handleUpdateOutputFormat = useCallback(async (format: string): Promise<void> => {
    try {
      setOutputFormat(format);
      await window.electronAPI.setOutputFormat(format);
    } catch (error) {
      console.error('Error updating output format:', error);
    }
  }, []);

  const handleUpdateDescriptiveNamingEnabled = useCallback(async (enabled: boolean): Promise<void> => {
    try {
      setDescriptiveNamingEnabled(enabled);
      await window.electronAPI.setDescriptiveNamingEnabled(enabled);
    } catch (error) {
      console.error('Error updating descriptive naming setting:', error);
    }
  }, []);

  return {
    ffmpegArgs,
    processingFormat,
    outputFormat,
    videoCompareArgs,
    defaultOutputFolder,
    descriptiveNamingEnabled,
    handleUpdateFfmpegArgs,
    handleResetFfmpegArgs,
    handleUpdateProcessingFormat,
    handleUpdateOutputFormat,
    handleUpdateVideoCompareArgs,
    handleResetVideoCompareArgs,
    handleUpdateDefaultOutputFolder,
    handleResetDefaultOutputFolder,
    handleUpdateDescriptiveNamingEnabled,
  };
};
