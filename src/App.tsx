// src/App.tsx - Refactored with extracted components and hooks

import { useState, useEffect, useRef, useCallback } from 'react';
import { NotificationContainer } from './components/NotificationContainer';
import { notify } from './utils/notifications';
import { QueuePanel } from './components/QueuePanel';
import { AppModals } from './components/AppModals';
import { ActionBar } from './components/ActionBar';
import { ConsoleDrawer } from './components/ConsoleDrawer';
import { Scrubber } from './components/Scrubber';
import { EngineBuildBanner } from './components/EngineBuildBanner';
import type { BackendId, EngineBuildStatus, UpdateInfo, SegmentSelection, VsMlrtVersionInfo, Filter, FilterParameterValues } from './electron';
import { getBackendDescriptor, resolveFilterBackend } from './utils/backends';
import { AppRail } from './components/AppRail';
import { TitleStrip } from './components/TitleStrip';
import { ModelBuildNotification } from './components/ModelBuildNotification';
import { useModels } from './hooks/useModels';
import { useSettings } from './hooks/useSettings';
import { usePrivacyMode } from './hooks/usePrivacyMode';
import { useConsoleLog } from './hooks/useConsoleLog';
import { useModelImport } from './hooks/useModelImport';
import { useVideoDragDrop } from './hooks/useVideoDragDrop';
import { useFilterTemplates } from './hooks/useFilterTemplates';
import { useWorkflow } from './hooks/useWorkflow';
import { useSetup } from './hooks/useSetup';
import { useVideoProcessing } from './hooks/useVideoProcessing';
import { useOutputResolution } from './hooks/useOutputResolution';
import { useColorimetry } from './hooks/useColorimetry';
import { useFilterConfig } from './hooks/useFilterConfig';
import { useUIState } from './hooks/useUIState';
import { useBackendOperations } from './hooks/useBackendOperations';
import { useAppEffects } from './hooks/useAppEffects';
import { useQueueStore } from './hooks/useQueueStore';
import { useQueueOperations } from './hooks/useQueueOperations';
import { useQueueProcessing } from './hooks/useQueueProcessing';
import { useBatchConfig } from './hooks/useBatchConfig';
import { useProcessingConfig } from './hooks/useProcessingConfig';
import { getErrorMessage } from './types/errors';
import { SetupScreen } from './components/SetupScreen';
import { VideoPreviewPanel } from './components/VideoPreviewPanel';
import { VideoInputPanel } from './components/VideoInputPanel';
import { VideoInfoPanel } from './components/VideoPanel';
import { OutputSettingsPanel } from './components/OutputSettingsPanel';
import { ModelSelectionPanel } from './components/ModelSelectionPanel';
import { getPortableModelName } from './utils/modelUtils';
import { useAccentColor } from './hooks/useAccentColor';
import { useMainColor } from './hooks/useMainColor';
import { useDiscordRichPresence } from './hooks/useDiscordRichPresence';

// Settings column drag bounds, in pixels.
const SETTINGS_MIN_W = 320;
const SETTINGS_MAX_W = 720;

function parseFrameSize(resolution: string | undefined): { width: number; height: number } | null {
  const match = resolution?.match(/(\d+)\s*[xX]\s*(\d+)/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

function App() {
  // Ref to preserve scroll position in right panel
  const rightPanelRef = useRef<HTMLDivElement>(null);

  // GPU stats polling (always-on, independent of processing)
  const [gpuStats, setGpuStats] = useState<{ gpuMemoryUsed: number; gpuMemoryTotal: number; gpuUtilization: number } | null>(null);
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const stats = await window.electronAPI.getGpuStats();
        if (active) setGpuStats(stats);
      } catch { /* nvidia-smi unavailable */ }
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => { active = false; clearInterval(interval); };
  }, []);

  // Runtime TensorRT engine builds happening inside vspipe. These take minutes
  // and produce no other feedback, so the main process forwards the [vk-build]
  // protocol it parses off stderr and the banner explains the wait.
  const [engineBuild, setEngineBuild] = useState<EngineBuildStatus | null>(null);
  useEffect(() => {
    return window.electronAPI.onEngineBuildProgress((status) => {
      setEngineBuild(status.status === 'building' ? status : null);
    });
  }, []);

  // Setup and initialization hooks
  const { consoleOutput, consoleEndRef, addConsoleLog } = useConsoleLog();
  const { isSetupComplete, isCheckingDeps, hasCudaSupport, recommendedBackend, setupProgress, isSettingUp, handleSetup, pluginInstallError, handleRetryPlugins, handleContinueWithoutPlugins } = useSetup(addConsoleLog);
  const { defaultBackend, setDefaultBackend, numStreams, updateNumStreams, showBackendOverrides, setShowBackendOverrides } = useSettings(recommendedBackend);
  const { privacyMode, togglePrivacyMode } = usePrivacyMode();
  const {
    discordRichPresenceSettings,
    updateDiscordRichPresenceSettings,
    publishDiscordRichPresence,
    clearDiscordRichPresence,
  } = useDiscordRichPresence(isSetupComplete);
  const { accentColor, setAccentColor, resetAccentColor } = useAccentColor();
  const { mainColor, setMainColor, resetMainColor } = useMainColor();
  const { 
    ffmpegArgs, 
    processingFormat,
    outputFormat,
    videoCompareArgs,
    defaultOutputFolder,
    descriptiveNamingEnabled,
    handleUpdateFfmpegArgs, 
    handleUpdateProcessingFormat,
    handleUpdateOutputFormat,
    handleUpdateVideoCompareArgs,
    handleResetVideoCompareArgs,
    handleUpdateDefaultOutputFolder,
    handleResetDefaultOutputFolder,
    handleUpdateDescriptiveNamingEnabled,
  } = useProcessingConfig(isSetupComplete);
  
  // Model management hooks
  const {
    availableModels,
    selectedModel,
    setSelectedModel,
    loadModels,
    loadUninitializedModels,
    uninitializedModels,
  } = useModels(isSetupComplete);
  const { templates: filterTemplates, saveTemplate, deleteTemplate, loadTemplates } = useFilterTemplates(isSetupComplete);
  
  // State management hooks
  const { filters, handleSetFilters, canUndo, canRedo, handleUndo, handleRedo } = useFilterConfig(isSetupComplete, addConsoleLog);
  const [activeFilterEditorId, setActiveFilterEditorId] = useState<string | null>(null);
  const { colorimetrySettings, handleColorimetryChange } = useColorimetry(isSetupComplete, addConsoleLog);
  const {
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
  } = useUIState();
  
  // Benchmark mode state
  const [benchmarkMode, setBenchmarkMode] = useState(false);

  // Segment selection state
  const [segment, setSegment] = useState<SegmentSelection>({
    enabled: false,
    startFrame: 0,
    endFrame: -1, // -1 means end of video
  });
  
  // Update notification state
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  
  // vs-mlrt version mismatch notification state
  const [vsMlrtVersionInfo, setVsMlrtVersionInfo] = useState<VsMlrtVersionInfo | null>(null);
  const [showVsMlrtModal, setShowVsMlrtModal] = useState(false);

  // vs-view loading state
  const [isLaunchingPreviewer, setIsLaunchingPreviewer] = useState(false);
  const [previewerStatus, setPreviewerStatus] = useState<'idle' | 'success' | 'error'>('idle');

  // Pre-queue workflow state to restore when queue is closed
  const [preQueueWorkflow, setPreQueueWorkflow] = useState<{
    videoPath: string | null;
    outputPath: string | null;
    selectedModel: string | null;
    filters: any[];
    outputFormat: string;
    defaultBackend: BackendId;
    numStreams: number;
    segment: SegmentSelection;
  } | null>(null);

  // Queue store (data + UI state)
  const queueStore = useQueueStore({ onLog: addConsoleLog, descriptiveNamingEnabled });

  // Video processing hooks
  const {
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
    indexingProgress,
  } = useVideoProcessing({
    outputFormat,
    onLog: addConsoleLog,
    descriptiveNamingEnabled,
    defaultOutputFolder,
    filters,
    selectedModel,
    colorimetry: colorimetrySettings,
    segment,
  });

  const [discordPresenceStartTimestamp, setDiscordPresenceStartTimestamp] = useState<number | undefined>();
  const discordPresenceHiddenForPrivacyRef = useRef(false);
  useEffect(() => {
    setDiscordPresenceStartTimestamp(isProcessing ? Math.floor(Date.now() / 1000) : undefined);
  }, [isProcessing]);

  useEffect(() => {
    if (!isSetupComplete) return;

    if (privacyMode) {
      if (!discordPresenceHiddenForPrivacyRef.current) {
        discordPresenceHiddenForPrivacyRef.current = true;
        void clearDiscordRichPresence();
      }
      return;
    }

    discordPresenceHiddenForPrivacyRef.current = false;

    if (isProcessing) {
      const percentage = upscaleProgress?.percentage;
      const state = typeof percentage === 'number'
        ? `${Math.max(0, Math.min(100, Math.round(percentage)))}% complete`
        : 'Processing';
      void publishDiscordRichPresence({
        details: 'Upscaling a video',
        state,
        startTimestamp: discordPresenceStartTimestamp,
      });
      return;
    }

    void publishDiscordRichPresence(videoInfo
      ? {
          details: 'Video loaded',
          state: 'Ready to upscale',
        }
      : {
          details: 'Ready to upscale',
          state: 'Waiting for a video',
        });
  }, [
    discordPresenceStartTimestamp,
    clearDiscordRichPresence,
    isProcessing,
    isSetupComplete,
    privacyMode,
    publishDiscordRichPresence,
    upscaleProgress?.percentage,
    videoInfo,
  ]);
  
  // Destructure queue store for convenience
  const {
    queue,
    addToQueue,
    removeFromQueue,
    updateQueueItem,
    updateItemWorkflow,
    clearQueue,
    clearCompletedItems,
    reorderQueue,
    getNextPendingItem,
    requeueItem,
    duplicateQueueItem,
  } = queueStore;

  // Batch configuration hook
  const {
    handleSelectVideoWithQueue,
    handleBatchFiles,
    handleAddCurrentVideoToQueue,
  } = useBatchConfig({
    ffmpegArgs,
    processingFormat,
    outputFormat,
    videoCompareArgs,
    selectedModel,
    filters,
    defaultBackend,
    numStreams,
    segment,
    colorimetry: colorimetrySettings,
    showQueue: queueStore.showQueue,
    descriptiveNamingEnabled,
    onAddToQueue: (videoPaths, workflow, outputPath) => {
      addToQueue(videoPaths, workflow, outputPath);
      queueStore.setShowQueue(true);
    },
    onLoadVideoInfo: loadVideoInfo,
    onLog: addConsoleLog,
  });

  // Queue operations hook (handlers + editing effects)
  const {
    handleSelectQueueItem,
    handleStartQueue,
    handleStopQueue,
    handleCancelQueueItem,
    handleRequeueItem,
    handleCompareQueueItem,
    handleOpenQueueItemFolder,
  } = useQueueOperations({
    queue,
    editingQueueItemId: queueStore.editingQueueItemId,
    showQueue: queueStore.showQueue,
    selectedModel,
    filters,
    ffmpegArgs,
    processingFormat,
    outputFormat,
    videoCompareArgs,
    defaultBackend,
    numStreams,
    segment,
    colorimetry: colorimetrySettings,
    isProcessingQueueItem: queueStore.isProcessingQueueItem,
    setEditingQueueItemId: queueStore.setEditingQueueItemId,
    setIsQueueStarted: queueStore.setIsQueueStarted,
    setIsProcessingQueue: queueStore.setIsProcessingQueue,
    setIsProcessingQueueItem: queueStore.setIsProcessingQueueItem,
    setIsQueueStopping: queueStore.setIsQueueStopping,
    setSelectedModel,
    setFilters: handleSetFilters,
    setOutputFormat: handleUpdateOutputFormat,
    setDefaultBackend,
    updateNumStreams,
    setSegment,
    updateQueueItem,
    updateItemWorkflow,
    requeueItem,
    loadVideoInfo,
    setOutputPath,
    handleCancelUpscale,
    onLog: addConsoleLog,
    loadCompletedVideo,
    setCompletedVideoPath,
  });

  // Queue processing effects
  useQueueProcessing({
    queue,
    isQueueStarted: queueStore.isQueueStarted,
    isQueueStopping: queueStore.isQueueStopping,
    isProcessingQueueItem: queueStore.isProcessingQueueItem,
    isProcessingQueue: queueStore.isProcessingQueue,
    isProcessing,
    upscaleProgress,
    setIsProcessingQueue: queueStore.setIsProcessingQueue,
    setIsProcessingQueueItem: queueStore.setIsProcessingQueueItem,
    setIsQueueStarted: queueStore.setIsQueueStarted,
    setVideoInfo,
    setOutputPath,
    updateQueueItem,
    getNextPendingItem,
    onLog: addConsoleLog,
  });
  
  // Workflow management hook
  const {
    currentWorkflow,
    handleLoadWorkflow,
    handleClearWorkflow,
    handleExportWorkflow,
    handleImportWorkflow,
    importModalState,
    closeImportModal,
    confirmImportFilters,
  } = useWorkflow({
    filters,
    selectedModel,
    setFilters: handleSetFilters,
    setSelectedModel,
    availableModels: availableModels.map(m => m.path),
    addConsoleLog,
    filterTemplates,
    refreshFilterTemplates: loadTemplates,
    // Encoding settings
    ffmpegArgs,
    processingFormat,
    outputFormat,
    videoCompareArgs,
    defaultBackend,
    numStreams,
    segment,
    colorimetry: colorimetrySettings,
    setFfmpegArgs: handleUpdateFfmpegArgs,
    setProcessingFormat: handleUpdateProcessingFormat,
    setOutputFormat: handleUpdateOutputFormat,
    setVideoCompareArgs: handleUpdateVideoCompareArgs,
    setDefaultBackend,
    updateNumStreams,
    setSegment,
    handleColorimetryChange,
  });

  // Model import hook
  const {
    showImportModal,
    setShowImportModal,
    modalMode,
    setModalMode,
    importProgress,
    isImporting,
    importForm,
    setImportForm,
    handleSelectOnnxFile,
    handleImportModel,
    handleCancelBuild,
    handleModelTypeChange,
    handleShapeModeChange,
    handleFp32Change,
    handlePrecisionChange,
    handleTemporalFramesChange,
    handleAutoBuildModel,
    showAutoBuildModal,
    autoBuildModelName,
    autoBuildModelType,
    autoBuildIsStatic,
    autoBuildStaticShape,
  } = useModelImport(defaultBackend, async (enginePath?: string) => {
    await loadModels();
    await loadUninitializedModels();
    // Auto-select the imported/built model
    if (enginePath) {
      setSelectedModel(enginePath);
      addConsoleLog(`Auto-selected model: ${enginePath}`);
      
      // Also update AI Model filters to use the new engine
      if (filters.length > 0) {
        const enginePortableName = getPortableModelName(enginePath);
        const updatedFilters = filters.map(filter => {
          if (filter.filterType === 'aiModel' && filter.modelPath) {
            const filterPortableName = getPortableModelName(filter.modelPath);
            // If this filter is using the ONNX version of the same model, switch to the engine
            if (filterPortableName === enginePortableName) {
              addConsoleLog(`Updated filter to use built engine: ${enginePath}`);
              return { ...filter, modelPath: enginePath };
            }
          }
          return filter;
        });
        
        if (JSON.stringify(updatedFilters) !== JSON.stringify(filters)) {
          handleSetFilters(updatedFilters);
        }
      }
    }
  }, addConsoleLog);
  
  // Backend operations hook
  const { handleReloadBackend, handleBuildModel } = useBackendOperations({
    onLog: addConsoleLog,
    loadModels,
    loadUninitializedModels,
    loadTemplates,
    setImportForm,
    setModalMode,
    setShowImportModal,
    handleAutoBuildModel,
    defaultBackend,
    setIsReloading,
  });

  // Drag and drop hook
  const { isDragging, handleDragOver, handleDragLeave, handleDrop } = useVideoDragDrop(
    isProcessing,
    async (filePaths: string[]) => {
      try {
        addConsoleLog(`Dropped ${filePaths.length} video(s)`);
        await handleBatchFiles(filePaths);
      } catch (error) {
        addConsoleLog(`Error: ${getErrorMessage(error)}`);
      }
    }
  );
  
  // Handle queue toggle - save/restore workflow state
  const handleToggleQueue = async () => {
    const newShowQueue = !queueStore.showQueue;
    
    if (newShowQueue) {
      // Opening queue - save current workflow state
      setPreQueueWorkflow({
        videoPath: videoInfo?.path || null,
        outputPath: outputPath,
        selectedModel,
        filters: structuredClone(filters), // Deep copy
        outputFormat,
        defaultBackend,
        numStreams,
        segment: { ...segment },
      });
      
      // If a video is loaded, add it to the queue
      if (videoInfo && outputPath) {
        handleAddCurrentVideoToQueue(videoInfo.path, outputPath);
      }
    } else {
      // Closing queue - restore pre-queue workflow
      if (preQueueWorkflow) {
        // Restore all settings
        if (preQueueWorkflow.selectedModel !== selectedModel) {
          setSelectedModel(preQueueWorkflow.selectedModel);
        }
        if (JSON.stringify(preQueueWorkflow.filters) !== JSON.stringify(filters)) {
          handleSetFilters(preQueueWorkflow.filters);
        }
        if (preQueueWorkflow.outputFormat !== outputFormat) {
          handleUpdateOutputFormat(preQueueWorkflow.outputFormat);
        }
        if (preQueueWorkflow.defaultBackend !== defaultBackend) {
          setDefaultBackend(preQueueWorkflow.defaultBackend);
        }
        if (preQueueWorkflow.numStreams !== numStreams) {
          updateNumStreams(preQueueWorkflow.numStreams);
        }
        if (JSON.stringify(preQueueWorkflow.segment) !== JSON.stringify(segment)) {
          setSegment(preQueueWorkflow.segment);
        }
        
        // Restore video and output path
        if (preQueueWorkflow.videoPath) {
          await loadVideoInfo(preQueueWorkflow.videoPath);
          if (preQueueWorkflow.outputPath) {
            setOutputPath(preQueueWorkflow.outputPath);
          }
        } else {
          // No video was loaded - clear current video
          setVideoInfo(null);
          setOutputPath('');
        }
        
        setPreQueueWorkflow(null);
      }
    }
    
    queueStore.setShowQueue(newShowQueue);
  };
  
  // Output resolution validation hook (manual trigger only)
  const { isValidating, validationStatus, validationError, validateWorkflow, cancelValidation, clearValidationStatus } = useOutputResolution({
    videoInfo,
    selectedModel: selectedModel || '',
    defaultBackend,
    filters,
    numStreams,
    onLog: addConsoleLog,
    onUpdateVideoInfo: setVideoInfo,
    onError: (message) => notify.error('Workflow Validation Error', message),
  });

  // Clear validation status when workflow or loaded video changes
  useEffect(() => {
    clearValidationStatus();
    setPreviewerStatus('idle');
  }, [filters, selectedModel, defaultBackend, numStreams, videoInfo?.path, clearValidationStatus]);

  // Reset segment selection when video changes (but not when loading a queue item)
  useEffect(() => {
    // Don't reset segment when we're editing a queue item - the segment will be restored from the queue item's workflow
    if (videoInfo && !queueStore.editingQueueItemId) {
      setSegment({
        enabled: false,
        startFrame: 0,
        endFrame: -1,
      });
    }
  }, [videoInfo?.path, queueStore.editingQueueItemId]);

  // App-level side effects (update check, vs-mlrt version check, error handlers, focus recovery)
  const { closeModalWithFocusRestore } = useAppEffects({
    isSetupComplete,
    hasCudaSupport,
    previewFrame,
    rightPanelRef,
    addConsoleLog,
    setUpdateInfo,
    setShowUpdateModal,
    setVsMlrtVersionInfo,
    setShowVsMlrtModal,
  });

  const handleChangeBackend = (backend: BackendId): void => {
    setDefaultBackend(backend);
    addConsoleLog(`Default inference backend changed to: ${getBackendDescriptor(backend).label}`);
  };

  // Segment selection handlers
  const handleSegmentChange = useCallback((newSegment: SegmentSelection) => {
    setSegment(newSegment);
    if (newSegment.enabled) {
      addConsoleLog(`Segment selection: frames ${newSegment.startFrame} to ${newSegment.endFrame === -1 ? 'end' : newSegment.endFrame}`);
    }
  }, [addConsoleLog]);

  const handlePreviewSegment = useCallback(async (startFrame: number, endFrame: number) => {
    if (!videoInfo) return;
    
    const previewSeconds = Math.ceil((endFrame - startFrame) / (videoInfo.fps || 24));
    addConsoleLog(`Starting ${previewSeconds}-second preview from frame ${startFrame}...`);
    try {
      const result = await window.electronAPI.previewSegment(
        videoInfo.path,
        selectedModel,
        defaultBackend,
        true,
        filters,
        numStreams,
        startFrame,
        endFrame
      );
      
      if (result.success && result.previewPath) {
        addConsoleLog(`Preview complete: ${result.previewPath}`);
        // Load the preview into the built-in video player
        setCompletedVideoPath(result.previewPath);
        await loadCompletedVideo(result.previewPath);
      } else {
        addConsoleLog(`Preview failed: ${result.error}`);
      }
    } catch (error) {
      addConsoleLog(`Preview error: ${getErrorMessage(error)}`);
    }
  }, [videoInfo, selectedModel, defaultBackend, filters, numStreams, addConsoleLog, loadCompletedVideo, setCompletedVideoPath]);

  // Launch vs-view with current workflow
  const handleLaunchPreviewer = useCallback(async () => {
    if (!videoInfo || isLaunchingPreviewer) return;
    
    setIsLaunchingPreviewer(true);
    setPreviewerStatus('idle');
    addConsoleLog('Launching vs-view with current workflow...');
    
    try {
      const result = await window.electronAPI.launchVsePreviewer(
        videoInfo.path,
        selectedModel,
        defaultBackend,
        true,
        filters,
        numStreams,
        segment
      );
      
      if (result.success) {
        addConsoleLog('vs-view launched successfully');
        notify.success('Previewer Launched', 'vs-view opened successfully');
        setPreviewerStatus('success');
      } else {
        const errorMsg = result.error || 'Unknown error occurred';
        addConsoleLog(`Failed to launch previewer: ${errorMsg}`);
        notify.error('Previewer Launch Failed', errorMsg);
        setPreviewerStatus('error');
      }
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      addConsoleLog(`Error launching previewer: ${errorMsg}`);
      notify.error('Previewer Error', errorMsg);
      setPreviewerStatus('error');
    } finally {
      setIsLaunchingPreviewer(false);
    }
  }, [videoInfo, selectedModel, defaultBackend, filters, numStreams, segment, addConsoleLog, isLaunchingPreviewer]);

  // Seek to a specific frame in the video preview (used by segment selector)
  // Settings column width — pixel-based drag on its left edge, persisted.
  // Pixels, not percentages: a proportional split is what stretched the
  // column to ~970px on a 2560px display.
  const [settingsWidth, setSettingsWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem('vk-settings-width'));
    return Number.isFinite(stored) && stored >= SETTINGS_MIN_W && stored <= SETTINGS_MAX_W ? stored : 400;
  });
  const [isResizingSettings, setIsResizingSettings] = useState(false);
  const resizeStartRef = useRef({ x: 0, width: 400 });

  const handleSettingsResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizeStartRef.current = { x: e.clientX, width: settingsWidth };
    setIsResizingSettings(true);
  }, [settingsWidth]);

  useEffect(() => {
    if (!isResizingSettings) return;
    const onMove = (e: MouseEvent) => {
      const delta = resizeStartRef.current.x - e.clientX;
      setSettingsWidth(Math.min(SETTINGS_MAX_W, Math.max(SETTINGS_MIN_W, resizeStartRef.current.width + delta)));
    };
    const onUp = () => setIsResizingSettings(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizingSettings]);

  useEffect(() => {
    if (!isResizingSettings) window.localStorage.setItem('vk-settings-width', String(settingsWidth));
  }, [settingsWidth, isResizingSettings]);

  // Which frame the preview is showing — drives the scrubber playhead.
  const [playheadFrame, setPlayheadFrame] = useState<number | null>(null);

  const handleSeekFrame = useCallback(async (frameNumber: number) => {
    if (!videoInfo) return;
    
    try {
      const frameImage = await window.electronAPI.getVideoFrameAt(
        videoInfo.path,
        frameNumber,
        videoInfo.fps || 24
      );
      
      if (frameImage) {
        updatePreviewFrame(frameImage);
        setPlayheadFrame(frameNumber);
      }
    } catch (error) {
      // Silently fail - frame extraction is non-critical
      console.warn('Failed to extract frame:', error);
    }
  }, [videoInfo, updatePreviewFrame]);

  const activeFilterEditor = activeFilterEditorId
    ? filters.find(filter => filter.id === activeFilterEditorId) ?? null
    : null;
  const cropSourceSize = parseFrameSize(videoInfo?.resolution);

  const handleOpenFilterEditor = useCallback(async (filter: Filter) => {
    if (!videoInfo) {
      notify.warning('Select a video first', 'A source frame is needed to use the visual filter editor.');
      return;
    }

    setActiveFilterEditorId(filter.id);
    const frameNumber = playheadFrame ?? 0;
    try {
      // Always use an unprocessed source frame. A processed preview might have
      // already been cropped or resized, which would make pixel values wrong.
      const frameImage = await window.electronAPI.getVideoFrameAt(
        videoInfo.path,
        frameNumber,
        videoInfo.fps || 24,
      );
      if (frameImage) {
        updatePreviewFrame(frameImage);
        setPlayheadFrame(frameNumber);
      } else {
        notify.error('Crop editor unavailable', 'Could not load a source frame for the editor.');
      }
    } catch (error) {
      console.warn('Failed to load frame for visual filter editor:', error);
      notify.error('Crop editor unavailable', 'Could not load a source frame for the editor.');
    }
  }, [playheadFrame, updatePreviewFrame, videoInfo]);

  const handleFilterParametersChange = useCallback((filterId: string, parameters: FilterParameterValues) => {
    handleSetFilters(filters.map(filter => filter.id === filterId ? { ...filter, parameters } : filter));
  }, [filters, handleSetFilters]);

  useEffect(() => {
    if (!activeFilterEditorId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActiveFilterEditorId(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeFilterEditorId]);

  // Determine if processing should be disabled
  // Console drawer — stable identities so the memoised bar and drawer don't
  // re-render on every parent tick.
  const handleToggleConsole = useCallback(() => setShowConsole(!showConsole), [showConsole, setShowConsole]);
  const handleCloseConsole = useCallback(() => setShowConsole(false), [setShowConsole]);

  // Determine if processing should be disabled
  // With the queue a persistent selectable list, the Source header states
  // which item these settings apply to — the old editing banner is gone.
  const queueEditingLabel = (() => {
    if (!queueStore.editingQueueItemId) return undefined;
    const index = queue.findIndex(q => q.id === queueStore.editingQueueItemId);
    return index === -1 ? undefined : `editing ${index + 1} of ${queue.length}`;
  })();

  const isStartDisabled = (() => {
    // Disable if stopping
    if (isStopping) return true;

    // Basic validation - benchmark mode doesn't need outputPath
    if (!videoInfo) return true;
    if (!benchmarkMode && !outputPath) return true;
    
    // Prevent processing when a filter's effective backend needs a built
    // engine but the filter still points at a raw ONNX model
    const hasUnbuiltModel = filters.some(f =>
      f.enabled &&
      f.filterType === 'aiModel' &&
      f.modelPath &&
      f.modelPath.toLowerCase().endsWith('.onnx') &&
      getBackendDescriptor(resolveFilterBackend(f.backend, defaultBackend)).requiresEngineBuild
    );
    if (hasUnbuiltModel) return true;
    
    // Allow processing without AI model as long as there's at least one enabled filter or no filters at all
    // Allow if there are no filters (pure processing)
    if (filters.length === 0) return false;
    
    // Allow if at least one filter is enabled (AI model or custom)
    const hasEnabledFilter = filters.some(f => f.enabled);
    return !hasEnabledFilter;
  })();

  // Setup Screen
  if (isCheckingDeps || !isSetupComplete) {
    return (
      <SetupScreen
        isCheckingDeps={isCheckingDeps}
        isSetupComplete={isSetupComplete}
        hasCudaSupport={hasCudaSupport}
        setupProgress={setupProgress}
        isSettingUp={isSettingUp}
        onSetup={handleSetup}
        pluginInstallError={pluginInstallError}
        onRetryPlugins={handleRetryPlugins}
        onContinueWithoutPlugins={handleContinueWithoutPlugins}
      />
    );
  }

  // Main App UI
  return (
    <div className="h-screen flex bg-ink-950 overflow-hidden">
      <NotificationContainer />

      {/* Tool rail — full height, left edge */}
      <AppRail
        isProcessing={isProcessing}
        showQueue={queueStore.showQueue}
        queueCount={queue.length}
        onToggleQueue={handleToggleQueue}
        isReloading={isReloading}
        privacyMode={privacyMode}
        onSettingsClick={() => setShowSettings(true)}
        onPluginsClick={() => setShowPlugins(true)}
        onReloadBackend={handleReloadBackend}
        onTogglePrivacyMode={togglePrivacyMode}
        onAboutClick={() => setShowAbout(true)}
      />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Title strip */}
        <TitleStrip
          isProcessing={isProcessing}
          defaultBackend={defaultBackend}
          onChangeBackend={handleChangeBackend}
          workflowName={currentWorkflow}
          onClearWorkflow={handleClearWorkflow}
          onLoadWorkflow={handleLoadWorkflow}
          onImportWorkflow={handleImportWorkflow}
          onExportWorkflow={handleExportWorkflow}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={handleUndo}
          onRedo={handleRedo}
          privacyMode={privacyMode}
          gpuStats={gpuStats}
        />

        {/* Notification Bar for Uninitialized Models */}
        <ModelBuildNotification
          defaultBackend={defaultBackend}
          availableModels={availableModels}
          uninitializedModels={uninitializedModels}
          filters={filters}
          onBuildModel={handleBuildModel}
        />

        {/* Main Content */}
        <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Queue — a pane you show or hide, not a mode that reshapes the window */}
        {queueStore.showQueue && (
          <div className="w-[240px] flex-shrink-0 min-h-0">
            <QueuePanel
              queue={queue}
              isQueueStarted={queueStore.isQueueStarted}
              editingItemId={queueStore.editingQueueItemId}
              privacyMode={privacyMode}
              onRemoveItem={removeFromQueue}
              onSelectItem={handleSelectQueueItem}
              onClearCompleted={clearCompletedItems}
              onClearAll={clearQueue}
              onReorder={reorderQueue}
              onCancelItem={handleCancelQueueItem}
              onRequeueItem={handleRequeueItem}
              onCompareItem={handleCompareQueueItem}
              onOpenItemFolder={handleOpenQueueItemFolder}
              onDropFiles={handleBatchFiles}
              onDuplicateItem={duplicateQueueItem}
            />
          </div>
        )}
        {/* Flush panes separated by hairlines — the strip and action bar are
            edge-to-edge, so the middle is too. No floating cards. */}
        <div className="flex-1 min-w-0 flex overflow-hidden">
              {/* Preview pane — the console opens over it, the scrubber sits under it */}
              <div className="relative flex flex-col flex-1 min-w-0 min-h-0">
                  <VideoPreviewPanel
                    previewFrame={previewFrame}
                    completedVideoPath={completedVideoPath}
                    completedVideoBlobUrl={completedVideoBlobUrl}
                    videoLoadError={videoLoadError}
                    isProcessing={isProcessing}
                    segmentEnabled={segment.enabled}
                    privacyMode={privacyMode}
                    onCompareVideos={handleCompareVideos}
                    onOpenOutputFolder={handleOpenOutputFolder}
                    onVideoError={handleVideoError}
                    activeFilterEditor={activeFilterEditor}
                    onCloseFilterEditor={() => setActiveFilterEditorId(null)}
                    onFilterParametersChange={handleFilterParametersChange}
                    cropSourceSize={cropSourceSize}
                  />

                  <Scrubber
                    videoInfo={videoInfo}
                    segment={segment}
                    isProcessing={isProcessing}
                    playhead={playheadFrame}
                    onSegmentChange={handleSegmentChange}
                    onSeekFrame={handleSeekFrame}
                    onPreviewSegment={handlePreviewSegment}
                  />

                  <ConsoleDrawer
                    open={showConsole}
                    onClose={handleCloseConsole}
                    consoleOutput={consoleOutput}
                    consoleEndRef={consoleEndRef}
                    privacyMode={privacyMode}
                  />
              </div>

              {/* Drag handle — a hairline with a 5px grab area */}
              <div
                onMouseDown={handleSettingsResizeStart}
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize the settings column"
                title="Drag to resize the settings column"
                className={`w-[5px] flex-shrink-0 cursor-ew-resize relative transition-colors ${
                  isResizingSettings ? 'bg-accent-500/30' : 'hover:bg-accent-500/20'
                }`}
              >
                <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-ink-800" aria-hidden="true" />
              </div>

              {/* Settings column — pixel width, dragged at its left edge */}
                <div ref={rightPanelRef} style={{ width: settingsWidth }} className="flex-shrink-0 flex flex-col overflow-y-auto overflow-x-hidden min-h-0 bg-ink-950">
                  {/* Video Input */}
                  <VideoInputPanel
                    editingLabel={queueEditingLabel}
                    videoInfo={videoInfo}
                    isDragging={isDragging}
                    isProcessing={isProcessing}
                    indexingProgress={indexingProgress}
                    privacyMode={privacyMode}
                    onSelectVideo={handleSelectVideoWithQueue}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                  />
                  
                  <ModelSelectionPanel
                    availableModels={availableModels}
                    isProcessing={isProcessing}
                    defaultBackend={defaultBackend}
                    showBackendOverrides={showBackendOverrides}
                    numStreams={numStreams}
                    colorimetrySettings={colorimetrySettings}
                    videoInfo={videoInfo}
                    filterTemplates={filterTemplates}
                    filters={filters}
                    onImportClick={() => {
                      setModalMode('import');
                      setShowImportModal(true);
                    }}
                    onModelsUpdated={async () => {
                      await loadModels();
                      await loadUninitializedModels();
                    }}
                    onColorimetryChange={handleColorimetryChange}
                    onFiltersChange={handleSetFilters}
                    onSaveTemplate={saveTemplate}
                    onDeleteTemplate={deleteTemplate}
                    onOpenFilterEditor={handleOpenFilterEditor}
                  />

                  {/* Output Settings */}
                  <OutputSettingsPanel
                    videoInfo={videoInfo}
                    outputPath={outputPath}
                    outputFormat={outputFormat}
                    ffmpegArgs={ffmpegArgs}
                    processingFormat={processingFormat}
                    isProcessing={isProcessing}
                    benchmarkMode={benchmarkMode}
                    privacyMode={privacyMode}
                    onFormatChange={handleUpdateOutputFormat}
                    onSelectOutputFile={handleSelectOutputFile}
                    onFfmpegArgsChange={handleUpdateFfmpegArgs}
                    onProcessingFormatChange={handleUpdateProcessingFormat}
                    onBenchmarkModeChange={setBenchmarkMode}
                  />

                  {/* Video Info */}
                  <VideoInfoPanel
                    videoInfo={videoInfo}
                    showVideoInfo={showVideoInfo}
                    onToggle={handleToggleVideoInfo}
                  />



                </div>
        </div>
        </div>

        {/* Engine build notice, then the one action bar */}
        <EngineBuildBanner engineBuild={engineBuild} />
        <ActionBar
          isProcessing={isProcessing}
          isStopping={isStopping}
          isStartDisabled={isStartDisabled}
          upscaleProgress={upscaleProgress}
          isValidating={isValidating}
          validationStatus={validationStatus}
          validationError={validationError}
          validateWorkflow={validateWorkflow}
          cancelValidation={cancelValidation}
          isLaunchingPreviewer={isLaunchingPreviewer}
          previewerStatus={previewerStatus}
          videoInfo={videoInfo}
          selectedModel={selectedModel}
          defaultBackend={defaultBackend}
          filters={filters}
          numStreams={numStreams}
          segment={segment}
          benchmarkMode={benchmarkMode}
          showQueue={queueStore.showQueue}
          isQueueStarted={queueStore.isQueueStarted}
          isQueueStopping={queueStore.isQueueStopping}
          queue={queue}
          handleForceStop={handleForceStop}
          handleLaunchPreviewer={handleLaunchPreviewer}
          handleUpscale={handleUpscale}
          handleCancelUpscale={handleCancelUpscale}
          handleStartQueue={handleStartQueue}
          handleStopQueue={handleStopQueue}
          showConsole={showConsole}
          onToggleConsole={handleToggleConsole}
        />
      </div>

      {/* Modals */}
      <AppModals
        showImportModal={showImportModal}
        onCloseImportModal={() => closeModalWithFocusRestore(() => setShowImportModal(false))}
        isImporting={isImporting}
        importForm={importForm}
        setImportForm={setImportForm}
        handleSelectOnnxFile={handleSelectOnnxFile}
        handleImportModel={handleImportModel}
        handleCancelBuild={handleCancelBuild}
        handleModelTypeChange={handleModelTypeChange}
        handleShapeModeChange={handleShapeModeChange}
        handleFp32Change={handleFp32Change}
        handlePrecisionChange={handlePrecisionChange}
        handleTemporalFramesChange={handleTemporalFramesChange}
        importProgress={importProgress}
        modalMode={modalMode}
        defaultBackend={defaultBackend}
        showAutoBuildModal={showAutoBuildModal}
        autoBuildModelName={autoBuildModelName}
        autoBuildModelType={autoBuildModelType}
        autoBuildIsStatic={autoBuildIsStatic}
        autoBuildStaticShape={autoBuildStaticShape}
        showSettings={showSettings}
        onCloseSettings={() => closeModalWithFocusRestore(() => setShowSettings(false))}
        numStreams={numStreams}
        onUpdateNumStreams={updateNumStreams}
        onChangeBackend={handleChangeBackend}
        showBackendOverrides={showBackendOverrides}
        onToggleBackendOverrides={setShowBackendOverrides}
        videoCompareArgs={videoCompareArgs}
        onUpdateVideoCompareArgs={handleUpdateVideoCompareArgs}
        onResetVideoCompareArgs={handleResetVideoCompareArgs}
        defaultOutputFolder={defaultOutputFolder}
        onUpdateDefaultOutputFolder={handleUpdateDefaultOutputFolder}
        onResetDefaultOutputFolder={handleResetDefaultOutputFolder}
        descriptiveNamingEnabled={descriptiveNamingEnabled}
        onUpdateDescriptiveNamingEnabled={handleUpdateDescriptiveNamingEnabled}
        discordRichPresenceSettings={discordRichPresenceSettings}
        onUpdateDiscordRichPresenceSettings={updateDiscordRichPresenceSettings}
        mainColor={mainColor}
        onChangeMainColor={setMainColor}
        onResetMainColor={resetMainColor}
        accentColor={accentColor}
        onChangeAccentColor={setAccentColor}
        onResetAccentColor={resetAccentColor}
        showAbout={showAbout}
        onCloseAbout={() => closeModalWithFocusRestore(() => setShowAbout(false))}
        showPlugins={showPlugins}
        onClosePlugins={() => closeModalWithFocusRestore(() => setShowPlugins(false))}
        onInstallationComplete={loadTemplates}
        showUpdateModal={showUpdateModal}
        updateInfo={updateInfo}
        onCloseUpdateModal={() => closeModalWithFocusRestore(() => setShowUpdateModal(false))}
        showVsMlrtModal={showVsMlrtModal}
        vsMlrtVersionInfo={vsMlrtVersionInfo}
        onCloseVsMlrtModal={() => closeModalWithFocusRestore(() => setShowVsMlrtModal(false))}
        onEnginesCleared={async () => { await loadModels(); await loadUninitializedModels(); }}
        importModalState={importModalState}
        closeImportModal={closeImportModal}
        confirmImportFilters={confirmImportFilters}
      />
    </div>
  );
}

export default App;
