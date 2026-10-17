import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { BackendId, ColorimetrySettings, VideoInfo, UpscaleProgress, Filter, SegmentSelection } from '../electron.d';
import { getBackendDescriptor } from '../utils/backends';
import { getErrorMessage } from '../types/errors';
import { notify } from '../utils/notifications';
import { ask } from '../utils/dialogs';
import { outputPathFor, withExtension } from '../utils/queueOutputPath';

interface UseVideoProcessingProps {
  outputFormat: string;
  onLog: (message: string) => void;
  descriptiveNamingEnabled: boolean;
  defaultOutputFolder: string | null;
  filters: Filter[];
  colorimetry: ColorimetrySettings;
  segment: SegmentSelection;
}

export function useVideoProcessing({
  outputFormat,
  onLog,
  descriptiveNamingEnabled,
  defaultOutputFolder,
  filters,
  colorimetry,
  segment,
}: UseVideoProcessingProps) {
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  // A path the user chose. Without one the output is named from the video and
  // the chain, and follows them as they change.
  const [outputPathOverride, setOutputPathOverride] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [upscaleProgress, setUpscaleProgress] = useState<UpscaleProgress | null>(null);
  const [previewFrame, setPreviewFrame] = useState<string | null>(null);
  const [completedVideoPath, setCompletedVideoPath] = useState<string | null>(null);
  const [completedVideoBlobUrl, setCompletedVideoBlobUrl] = useState<string | null>(null);
  const [videoLoadError, setVideoLoadError] = useState(false);
  const [indexingProgress, setIndexingProgress] = useState<number | null>(null);

  const outputPath = useMemo(() => {
    if (!videoInfo) return '';
    if (outputPathOverride) return withExtension(outputPathOverride, outputFormat);
    return outputPathFor(
      videoInfo,
      { colorimetry, filters, segment, outputFormat },
      { defaultOutputFolder, descriptive: descriptiveNamingEnabled },
    );
  }, [videoInfo, outputPathOverride, outputFormat, colorimetry, filters, segment, defaultOutputFolder, descriptiveNamingEnabled]);

  // Refs to avoid re-subscribing to the progress listener when these values change
  const isProcessingRef = useRef(isProcessing);
  const benchmarkModeRef = useRef(false);
  // The file the running render writes, fixed when it starts.
  const renderOutputRef = useRef<string | null>(null);

  // Keep refs in sync
  useEffect(() => {
    isProcessingRef.current = isProcessing;
  }, [isProcessing]);

  // Subscribe to BestSource indexing progress events from the backend
  useEffect(() => {
    const unsubscribe = window.electronAPI.onVideoIndexProgress((progress) => {
      if (progress.complete) {
        setIndexingProgress(null);
      } else {
        setIndexingProgress(progress.percentage);
      }
    });
    return unsubscribe;
  }, []);

  // Load completed video as blob URL
  const loadCompletedVideo = useCallback(async (videoPath: string): Promise<void> => {
    try {
      onLog('Loading completed video for playback...');

      // Reset state first to force the video element to reload
      setCompletedVideoBlobUrl(null);
      setVideoLoadError(false);
      setPreviewFrame(null); // Clear preview frame so video player shows instead

      // Use custom protocol to stream video directly from disk
      // This avoids loading the entire file into memory and bypasses size limits
      // Add timestamp to bust cache and ensure new video loads
      const videoUrl = `video://${videoPath}?t=${Date.now()}`;

      // Small delay to ensure React processes the null state first
      await new Promise(resolve => setTimeout(resolve, 50));

      setCompletedVideoBlobUrl(videoUrl);

      onLog('Video loaded successfully');
    } catch (error) {
      onLog(`Error loading video: ${getErrorMessage(error)}`);
      setVideoLoadError(true);
    }
  }, [onLog]);

  // Ref for loadCompletedVideo to avoid re-subscription
  const loadCompletedVideoRef = useRef(loadCompletedVideo);
  useEffect(() => {
    loadCompletedVideoRef.current = loadCompletedVideo;
  }, [loadCompletedVideo]);

  // Pending preview frame ref for requestAnimationFrame batching
  const pendingPreviewFrameRef = useRef<string | null>(null);
  const rafIdRef = useRef<number | null>(null);

  // Upscale progress listener - subscribe once and use refs to access current values
  useEffect(() => {
    const unsubscribe = window.electronAPI.onUpscaleProgress((progress: UpscaleProgress) => {
      if (progress.type === 'preview-frame' && progress.previewFrame) {
        // Store the pending frame and schedule update via requestAnimationFrame
        // This decouples the IPC handler from the React render cycle,
        // preventing GUI lag during video processing
        pendingPreviewFrameRef.current = `data:image/jpeg;base64,${progress.previewFrame}`;

        if (rafIdRef.current === null) {
          rafIdRef.current = requestAnimationFrame(() => {
            if (pendingPreviewFrameRef.current) {
              setPreviewFrame(pendingPreviewFrameRef.current);
              pendingPreviewFrameRef.current = null;
            }
            rafIdRef.current = null;
          });
        }
      } else {
        setUpscaleProgress(progress);
        onLog(`[Upscale] ${progress.message}`);

        // Update stopping state based on progress
        // Only set isStopping to true if we're still processing (avoid race condition with cancel)
        if (progress.isStopping && isProcessingRef.current) {
          setIsStopping(true);
        }

        if (progress.type === 'complete') {
          // Always reset stopping state when processing completes
          setIsStopping(false);

          // Cancel any pending preview frame updates
          if (rafIdRef.current !== null) {
            cancelAnimationFrame(rafIdRef.current);
            rafIdRef.current = null;
          }
          pendingPreviewFrameRef.current = null;

          // Only auto-load video if we're in a real processing session.
          if (isProcessingRef.current) {
            setIsProcessing(false);
            setPreviewFrame(null);
            // In benchmark mode there's no output file to load
            const written = renderOutputRef.current;
            if (!benchmarkModeRef.current && written) {
              setCompletedVideoPath(written);
              loadCompletedVideoRef.current(written);
            }
            renderOutputRef.current = null;
            benchmarkModeRef.current = false;
          }
        } else if (progress.type === 'error') {
          renderOutputRef.current = null;
          setIsProcessing(false);
          setIsStopping(false);
          // The status chip is a progress readout, not an error log: leaving
          // the message there strands a failure in a one-line truncated pill
          // that nothing ever clears. The toast is what carries it.
          setUpscaleProgress(null);
          notify.error('Processing failed', progress.message);
        }
      }
    });

    // Cleanup RAF on unmount
    return () => {
      unsubscribe();
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [onLog]); // Only re-subscribe if onLog changes (which it shouldn't)

  // Cleanup blob URL when component unmounts or new video starts
  useEffect(() => {
    return () => {
      if (completedVideoBlobUrl) {
        URL.revokeObjectURL(completedVideoBlobUrl);
      }
    };
  }, [completedVideoBlobUrl]);

  /** Load a video into the window, its output named automatically. Resolves to the video's info. */
  const loadVideoInfo = useCallback(async (filePath: string): Promise<VideoInfo> => {
    onLog(`Selected video: ${filePath}`);
    setIndexingProgress(0);
    let info: VideoInfo;
    try {
      info = await window.electronAPI.getVideoInfo(filePath);
    } catch (error) {
      setIndexingProgress(null);
      throw error;
    }

    // Cleanup old blob URL before loading new video
    if (completedVideoBlobUrl) {
      URL.revokeObjectURL(completedVideoBlobUrl);
    }

    setVideoInfo(info);
    setOutputPathOverride(null);
    onLog(`Video info: ${info.resolution || 'unknown'} @ ${info.fps || 'unknown'} FPS`);

    setPreviewFrame(null);
    setCompletedVideoPath(null);
    setCompletedVideoBlobUrl(null);
    setVideoLoadError(false);
    return info;
  }, [onLog, completedVideoBlobUrl]);

  const handleSelectVideo = async (): Promise<void> => {
    try {
      const files = await window.electronAPI.selectVideoFile();
      // Handle single file selection - take first file from array
      if (files && files.length > 0) {
        await loadVideoInfo(files[0]);
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
        setOutputPathOverride(selected);
        onLog(`Output path: ${selected}`);
      }
    } catch (error) {
      onLog(`Error: ${getErrorMessage(error)}`);
    }
  };

  const handleUpscale = async (
    selectedModel: string,
    defaultBackend: BackendId,
    filters: Filter[],
    numStreams: number = 2,
    segment?: SegmentSelection,
    benchmarkMode: boolean = false
  ): Promise<void> => {
    if (!videoInfo) return;
    if (!benchmarkMode && !outputPath) return;


    if (!benchmarkMode) {
      try {
        const fileExists = await window.electronAPI.fileExists(outputPath);
        if (fileExists) {
          const shouldOverwrite = await ask({
            title: 'Overwrite output',
            message: `The file "${outputPath}" already exists.\n\nOverwrite it?`,
            confirmLabel: 'Overwrite',
            tone: 'danger',
          });
          if (!shouldOverwrite) {
            onLog('Processing canceled - output file already exists');
            return;
          }
          onLog('Warning: Overwriting existing file');
        }
      } catch (error) {
        onLog(`Warning: Could not check if output file exists: ${getErrorMessage(error)}`);
      }
    }

    benchmarkModeRef.current = benchmarkMode;
    renderOutputRef.current = benchmarkMode ? null : outputPath;
    setIsProcessing(true);
    setIsStopping(false);
    setUpscaleProgress(null);
    setPreviewFrame(null);
    setCompletedVideoPath(null);
    setCompletedVideoBlobUrl(null);
    setVideoLoadError(false);
    onLog(benchmarkMode ? '=== Starting benchmark ===' : '=== Starting upscale process ===');
    const backend = getBackendDescriptor(defaultBackend);
    onLog(`Default backend: ${backend.label}`);
    onLog(`num_streams: ${numStreams}`);
    if (benchmarkMode) {
      onLog('Benchmark mode: output will be discarded');
    }
    if (segment?.enabled) {
      onLog(`Segment: frames ${segment.startFrame} to ${segment.endFrame === -1 ? 'end' : segment.endFrame}`);
    }

    try {
      const result = await window.electronAPI.startUpscale(
        videoInfo.path,
        selectedModel,
        outputPath || 'benchmark',
        defaultBackend,
        true,
        filters,
        0,
        numStreams,
        segment,
        benchmarkMode
      );
      if (!result.success) {
        onLog(`Error: ${result.error}`);
      }
    } catch (error) {
      onLog(`Error: ${getErrorMessage(error)}`);
      renderOutputRef.current = null;
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

    const partial = renderOutputRef.current || outputPath;
    renderOutputRef.current = null;
    if (partial) {
      setTimeout(async () => {
        try {
          onLog('Checking for partial output file...');
          await loadCompletedVideo(partial);
          setCompletedVideoPath(partial);
          onLog('Partial output file loaded successfully');
        } catch (error) {
          onLog('No partial output file found or unable to load');
        }
      }, 1000);
    }
  };

  const handleForceStop = async (): Promise<void> => {
    onLog('Force stopping upscale process...');
    setIsStopping(true);
    await window.electronAPI.killUpscale();
    renderOutputRef.current = null;
    setIsProcessing(false);
    setIsStopping(false);
    setUpscaleProgress(null);
    setPreviewFrame(null);
    onLog('Upscale process force stopped');
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
          notify.error('Comparison Tool Error', `Failed to launch comparison tool: ${result.error}`);
        }
      } catch (error) {
        onLog(`Error launching comparison tool: ${getErrorMessage(error)}`);
        notify.error('Comparison Tool Error', getErrorMessage(error));
      }
    }
  };

  const handleVideoError = (): void => {
    onLog('Video failed to load - incompatible format');
    setVideoLoadError(true);
  };

  // Set a preview frame image directly (used by segment selector)
  const updatePreviewFrame = useCallback((frame: string | null) => {
    setPreviewFrame(frame);
  }, []);

  return {
    videoInfo,
    setVideoInfo,
    outputPath,
    outputPathOverride,
    setOutputPathOverride,
    isProcessing,
    isStopping,
    upscaleProgress,
    previewFrame,
    completedVideoPath,
    completedVideoBlobUrl,
    videoLoadError,
    indexingProgress,
    loadVideoInfo,
    handleSelectVideo,
    handleSelectOutputFile,
    handleUpscale,
    handleCancelUpscale,
    handleForceStop,
    handleOpenOutputFolder,
    handleCompareVideos,
    handleVideoError,
    loadCompletedVideo,
    setCompletedVideoPath,
    updatePreviewFrame,
  };
}
