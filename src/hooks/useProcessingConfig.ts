import { useState, useEffect, useCallback, useRef } from 'react';

export const useProcessingConfig = (isSetupComplete: boolean) => {
  const [ffmpegArgs, setFfmpegArgs] = useState<string>('');
  const [processingFormat, setProcessingFormat] = useState<string>('vs.YUV420P8');
  const [outputFormat, setOutputFormat] = useState<string>('mkv');
  const [videoCompareArgs, setVideoCompareArgs] = useState<string>('-W');
  const [defaultOutputFolder, setDefaultOutputFolder] = useState<string | null>(null);
  const [descriptiveNamingEnabled, setDescriptiveNamingEnabled] = useState<boolean>(true);
  const [isLoaded, setIsLoaded] = useState(false);

  // Settings changed since mount. The load below is six round trips; a value
  // set while it is still going (a queue item resumed at launch, say) must not
  // be replaced by the older one it then reads back.
  const changedRef = useRef(new Set<string>());
  const unlessChanged = <T,>(key: string, set: (value: T) => void) => (value: T) => {
    if (!changedRef.current.has(key)) set(value);
  };

  // Load configuration on mount
  useEffect(() => {
    const loadConfig = async (): Promise<void> => {
      try {
        const argsResult = await window.electronAPI.getFfmpegArgs();
        unlessChanged('ffmpegArgs', setFfmpegArgs)(argsResult.args);

        const formatResult = await window.electronAPI.getProcessingFormat();
        unlessChanged('processingFormat', setProcessingFormat)(formatResult.format);

        const outputFormatResult = await window.electronAPI.getOutputFormat();
        unlessChanged('outputFormat', setOutputFormat)(outputFormatResult.format);

        const videoCompareResult = await window.electronAPI.getVideoCompareArgs();
        unlessChanged('videoCompareArgs', setVideoCompareArgs)(videoCompareResult.args);

        const defaultFolderResult = await window.electronAPI.getDefaultOutputFolder();
        unlessChanged('defaultOutputFolder', setDefaultOutputFolder)(defaultFolderResult.folder);

        const descriptiveNamingResult = await window.electronAPI.getDescriptiveNamingEnabled();
        unlessChanged('descriptiveNamingEnabled', setDescriptiveNamingEnabled)(descriptiveNamingResult.enabled);
      } catch (error) {
        console.error('Failed to load processing config:', error);
      } finally {
        setIsLoaded(true);
      }
    };

    if (isSetupComplete) {
      loadConfig();
    }
  }, [isSetupComplete]);

  const handleUpdateFfmpegArgs = useCallback(async (args: string): Promise<void> => {
    try {
      changedRef.current.add('ffmpegArgs');
      setFfmpegArgs(args);
      await window.electronAPI.setFfmpegArgs(args);
    } catch (error) {
      console.error('Error updating FFmpeg args:', error);
    }
  }, []);

  const handleResetFfmpegArgs = useCallback(async (): Promise<void> => {
    try {
      const result = await window.electronAPI.getDefaultFfmpegArgs();
      changedRef.current.add('ffmpegArgs');
      setFfmpegArgs(result.args);
      await window.electronAPI.setFfmpegArgs(result.args);
    } catch (error) {
      console.error('Error resetting FFmpeg args:', error);
    }
  }, []);

  const handleUpdateProcessingFormat = useCallback(async (format: string): Promise<void> => {
    try {
      changedRef.current.add('processingFormat');
      setProcessingFormat(format);
      await window.electronAPI.setProcessingFormat(format);
    } catch (error) {
      console.error('Error updating processing format:', error);
    }
  }, []);

  const handleUpdateVideoCompareArgs = useCallback(async (args: string): Promise<void> => {
    try {
      changedRef.current.add('videoCompareArgs');
      setVideoCompareArgs(args);
      await window.electronAPI.setVideoCompareArgs(args);
    } catch (error) {
      console.error('Error updating video compare args:', error);
    }
  }, []);

  const handleResetVideoCompareArgs = useCallback(async (): Promise<void> => {
    try {
      const result = await window.electronAPI.getDefaultVideoCompareArgs();
      changedRef.current.add('videoCompareArgs');
      setVideoCompareArgs(result.args);
      await window.electronAPI.setVideoCompareArgs(result.args);
    } catch (error) {
      console.error('Error resetting video compare args:', error);
    }
  }, []);

  const handleUpdateDefaultOutputFolder = useCallback(async (folder: string | null): Promise<void> => {
    try {
      changedRef.current.add('defaultOutputFolder');
      setDefaultOutputFolder(folder);
      await window.electronAPI.setDefaultOutputFolder(folder);
    } catch (error) {
      console.error('Error updating default output folder:', error);
    }
  }, []);

  const handleResetDefaultOutputFolder = useCallback(async (): Promise<void> => {
    try {
      changedRef.current.add('defaultOutputFolder');
      setDefaultOutputFolder(null);
      await window.electronAPI.setDefaultOutputFolder(null);
    } catch (error) {
      console.error('Error resetting default output folder:', error);
    }
  }, []);

  const handleUpdateOutputFormat = useCallback(async (format: string): Promise<void> => {
    try {
      changedRef.current.add('outputFormat');
      setOutputFormat(format);
      await window.electronAPI.setOutputFormat(format);
    } catch (error) {
      console.error('Error updating output format:', error);
    }
  }, []);

  const handleUpdateDescriptiveNamingEnabled = useCallback(async (enabled: boolean): Promise<void> => {
    try {
      changedRef.current.add('descriptiveNamingEnabled');
      setDescriptiveNamingEnabled(enabled);
      await window.electronAPI.setDescriptiveNamingEnabled(enabled);
    } catch (error) {
      console.error('Error updating descriptive naming setting:', error);
    }
  }, []);

  return {
    isLoaded,
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
