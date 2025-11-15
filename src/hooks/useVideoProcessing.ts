import { useState, useEffect, useCallback } from 'react';
import type { VideoInfo, UpscaleProgress, Filter } from '../electron.d';
import { getErrorMessage } from '../types/errors';

interface UseVideoProcessingProps {
  outputFormat: string;
  onLog: (message: string) => void;
}

export function useVideoProcessing({ outputFormat, onLog }: UseVideoProcessingProps) {
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [outputPath, setOutputPath] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [upscaleProgress, setUpscaleProgress] = useState<UpscaleProgress | null>(null);
  const [previewFrame, setPreviewFrame] = useState<string | null>(null);
  const [completedVideoPath, setCompletedVideoPath] = useState<string | null>(null);
  const [completedVideoBlobUrl, setCompletedVideoBlobUrl] = useState<string | null>(null);
  const [videoLoadError, setVideoLoadError] = useState(false);

  // Load completed video as blob URL
  const loadCompletedVideo = useCallback(async (videoPath: string): Promise<void> => {
    try {
      onLog('Loading completed video for playback...');
      const arrayBuffer = await window.electronAPI.readVideoFile(videoPath);
      
      // Determine MIME type based on file extension
      const ext = videoPath.toLowerCase().split('.').pop();
      let mimeType = 'video/mp4';
      if (ext === 'mkv') {
        mimeType = 'video/x-matroska';
      } else if (ext === 'webm') {
        mimeType = 'video/webm';
      } else if (ext === 'avi') {
        mimeType = 'video/x-msvideo';
      }
      
      const blob = new Blob([arrayBuffer], { type: mimeType });
      const blobUrl = URL.createObjectURL(blob);
      setCompletedVideoBlobUrl(blobUrl);
      onLog('Video loaded successfully');
    } catch (error) {
      onLog(`Error loading video: ${getErrorMessage(error)}`);
      setVideoLoadError(true);
    }
  }, [onLog]);

  // Upscale progress listener
  useEffect(() => {
    const unsubscribe = window.electronAPI.onUpscaleProgress((progress: UpscaleProgress) => {
      if (progress.type === 'preview-frame' && progress.previewFrame) {
        setPreviewFrame(`data:image/png;base64,${progress.previewFrame}`);
      } else {
        setUpscaleProgress(progress);
        onLog(`[Upscale] ${progress.message}`);
        
        // Update stopping state based on progress
        if (progress.isStopping) {
          setIsStopping(true);
        }
        
        if (progress.type === 'complete') {
          setIsProcessing(false);
          setIsStopping(false);
          setCompletedVideoPath(outputPath);
          setPreviewFrame(null);
          loadCompletedVideo(outputPath);
        } else if (progress.type === 'error') {
          setIsProcessing(false);
          setIsStopping(false);
        }
      }
    });

    return unsubscribe;
  }, [outputPath, onLog, loadCompletedVideo]);

  // Cleanup blob URL when component unmounts or new video starts
  useEffect(() => {
    return () => {
      if (completedVideoBlobUrl) {
        URL.revokeObjectURL(completedVideoBlobUrl);
      }
    };
  }, [completedVideoBlobUrl]);

  const loadVideoInfo = useCallback(async (filePath: string): Promise<void> => {
    onLog(`Selected video: ${filePath}`);
    const info = await window.electronAPI.getVideoInfo(filePath);
    
    // Cleanup old blob URL before loading new video
    if (completedVideoBlobUrl) {
      URL.revokeObjectURL(completedVideoBlobUrl);
    }
    
    setVideoInfo(info);
    onLog(`Video info: ${info.resolution || 'unknown'} @ ${info.fps || 'unknown'} FPS`);
    
    // Auto-suggest output path in same directory as input
    const autoOutputPath = filePath.replace(/\.[^/.]+$/, '') + '_processed.' + outputFormat;
    setOutputPath(autoOutputPath);
    onLog(`Auto-suggested output path: ${autoOutputPath}`);
    
    setPreviewFrame(null);
    setCompletedVideoPath(null);
    setCompletedVideoBlobUrl(null);
    setVideoLoadError(false);
  }, [onLog, completedVideoBlobUrl, outputFormat]);

  // Update output path when format changes
  useEffect(() => {
    if (videoInfo && outputPath) {
      const currentExt = outputPath.toLowerCase().split('.').pop();
      if (currentExt !== outputFormat.toLowerCase()) {
        const newOutputPath = outputPath.replace(/\.[^/.]+$/, '.' + outputFormat);
        setOutputPath(newOutputPath);
        onLog(`Output format changed to ${outputFormat.toUpperCase()}: ${newOutputPath}`);
      }
    }
  }, [outputFormat, videoInfo, outputPath, onLog]);

  const handleSelectVideo = async (): Promise<void> => {
    try {
      const filePath = await window.electronAPI.selectVideoFile();
      if (filePath) {
        await loadVideoInfo(filePath);
      }
    } catch (error) {
      onLog(`Error: ${getErrorMessage(error)}`);
    }
  };

  const handleSelectOutputFile = async (): Promise<void> => {
    if (!videoInfo) return;
    
    try {
      const defaultPath = outputPath || (videoInfo.name.replace(/\.[^/.]+$/, '') + '_processed.' + outputFormat);
      const selected = await window.electronAPI.selectOutputFile(defaultPath);
      if (selected) {
        setOutputPath(selected);
        onLog(`Output path: ${selected}`);
      }
    } catch (error) {
      onLog(`Error: ${getErrorMessage(error)}`);
    }
  };

  const handleUpscale = async (
    selectedModel: string,
    useDirectML: boolean,
    filters: Filter[],
    numStreams: number = 2
  ): Promise<void> => {
    if (!videoInfo || !outputPath) return;
    
    try {
      const fileExists = await window.electronAPI.fileExists(outputPath);
      if (fileExists) {
        const shouldOverwrite = window.confirm(
          `The file "${outputPath}" already exists.\n\nDo you want to overwrite it?`
        );
        if (!shouldOverwrite) {
          onLog('Processing canceled - output file already exists');
          return;
        }
        onLog('Warning: Overwriting existing file');
      }
    } catch (error) {
      onLog(`Warning: Could not check if output file exists: ${getErrorMessage(error)}`);
    }
    
    setIsProcessing(true);
    setIsStopping(false);
    setUpscaleProgress(null);
    setPreviewFrame(null);
    setCompletedVideoPath(null);
    setCompletedVideoBlobUrl(null);
    setVideoLoadError(false);
    onLog('=== Starting upscale process ===');
    onLog(`Using backend: ${useDirectML ? 'DirectML (ONNX Runtime)' : 'TensorRT'}`);
    if (!useDirectML) {
      onLog(`TensorRT num_streams: ${numStreams}`);
    }
    
    try {
      const result = await window.electronAPI.startUpscale(
        videoInfo.path, 
        selectedModel, 
        outputPath, 
        useDirectML,
        true,
        filters,
        0,
        numStreams
      );
      if (!result.success) {
        onLog(`Error: ${result.error}`);
      }
    } catch (error) {
      onLog(`Error: ${getErrorMessage(error)}`);
      setIsProcessing(false);
    }
  };

  const handleCancelUpscale = async (): Promise<void> => {
    onLog('Canceling upscale...');
    setIsStopping(true);
    await window.electronAPI.cancelUpscale();
    setIsProcessing(false);
    setIsStopping(false);
    setUpscaleProgress(null);
    setPreviewFrame(null);
    setCompletedVideoBlobUrl(null);
    
    if (outputPath) {
      setTimeout(async () => {
        try {
          onLog('Checking for partial output file...');
          await loadCompletedVideo(outputPath);
          setCompletedVideoPath(outputPath);
          onLog('Partial output file loaded successfully');
        } catch (error) {
          onLog('No partial output file found or unable to load');
        }
      }, 1000);
    }
  };

  const handleOpenOutputFolder = async (): Promise<void> => {
    if (completedVideoPath) {
      try {
        onLog(`Opening folder for: ${completedVideoPath}`);
        await window.electronAPI.openOutputFolder(completedVideoPath);
      } catch (error) {
        onLog(`Error opening folder: ${getErrorMessage(error)}`);
      }
    }
  };

  const handleCompareVideos = async (): Promise<void> => {
    if (videoInfo && completedVideoPath) {
      try {
        onLog('Launching video comparison tool...');
        const result = await window.electronAPI.compareVideos(videoInfo.path, completedVideoPath);
        if (result.success) {
          onLog('Video comparison tool launched successfully');
        } else {
          onLog(`Error: ${result.error}`);
          alert(`Failed to launch comparison tool: ${result.error}`);
        }
      } catch (error) {
        onLog(`Error launching comparison tool: ${getErrorMessage(error)}`);
        alert(`Error: ${getErrorMessage(error)}`);
      }
    }
  };

  const handleVideoError = (): void => {
    onLog('Video failed to load - incompatible format');
    setVideoLoadError(true);
  };

  return {
    videoInfo,
    setVideoInfo,
    outputPath,
    setOutputPath,
    isProcessing,
    isStopping,
    upscaleProgress,
    previewFrame,
    completedVideoPath,
    completedVideoBlobUrl,
    videoLoadError,
    loadVideoInfo,
    handleSelectVideo,
    handleSelectOutputFile,
    handleUpscale,
    handleCancelUpscale,
    handleOpenOutputFolder,
    handleCompareVideos,
    handleVideoError,
  };
}
