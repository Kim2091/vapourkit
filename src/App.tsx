// src/App.tsx - Refactored with extracted components and hooks

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
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
import { DlssRuntimeNotification } from './components/DlssRuntimeNotification';
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
import { ChevronLeft } from 'lucide-react';
import { SetupScreen } from './components/SetupScreen';
import { VideoPreviewPanel } from './components/VideoPreviewPanel';
import { ColorGradeDock, GRADE_COMPACT_BELOW, GRADE_DOCK_HEIGHT, GRADE_DOCK_COMPACT_HEIGHT } from './components/ColorGradeDock';
import { solveScopeColumnWidth, clampScopeColumnWidth } from './components/GradeScopeColumn';
import { gradeBasePx } from './components/gradeType';
import { writeCube, parseLut, to3d } from './utils/lut';
import { solveBlackPoint, solveWhitePoint, solveNeutral, autoBalance } from './utils/colorGrade';
import { useLutSteps } from './hooks/useLutSteps';
import type { LutPanelActions } from './components/DynamicFilterPanel';
import type { CompareMode, PickMode } from './components/ColorGradeOverlay';
import type { ViewerControls } from './components/PreviewStepRail';
import type { ToolRailControls } from './components/GradeToolRail';
import type { ScopeKind } from './components/GradeScopes';
import { useColorGrade } from './hooks/useColorGrade';
import { useChainPreview } from './hooks/useChainPreview';
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
  const { isSetupComplete, isCheckingDeps, hasCudaSupport, recommendedBackend, setupProgress, isSettingUp, handleSetup, pluginInstallError, setupError, setupWarnings, handleRetryPlugins, handleContinueWithoutPlugins } = useSetup(addConsoleLog);
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
  const { templates: filterTemplates, saveTemplate, deleteTemplate, restoreTemplates, loadTemplates } = useFilterTemplates(isSetupComplete);
  
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
  const [showUpdateReport, setShowUpdateReport] = useState(false);

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
    setShowUpdateReport,
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

  // The in-app previewer. While its session is open the picture comes from
  // VapourSynth at real resolution, through the same script the render uses,
  // rather than from ffmpeg's 640px JPEG.
  //
  // A fixed width for now; sizing it to the pane arrives with the zoom work,
  // which is when the difference starts to matter.
  const chainPreview = useChainPreview({
    videoInfo,
    filters,
    selectedModel,
    defaultBackend,
    numStreams,
    segment,
    previewWidth: 1280,
    liveParameterFilterId: activeFilterEditorId,
    onError: (message, phase) => {
      addConsoleLog(`Preview: ${message}`);
      // An open that fails leaves nothing on screen to carry the reason, so
      // it gets the toast. The console keeps every phase.
      if (phase === 'open') notify.error('Inspect could not open', message);
    },
    // Throttled inside the hook, so this is a few updates a second rather
    // than one per frame.
    onPlayhead: setPlayheadFrame,
  });

  const {
    isOpen: chainPreviewOpen,
    open: openChainPreview,
    close: closeChainPreview,
    cancel: cancelChainPreview,
    seek: seekChainPreview,
    select: selectChainStep,
    isOpening: isOpeningChainPreview,
  } = chainPreview;

  const handleToggleChainPreview = useCallback(() => {
    // Mid-open the button is a cancel: a preflight can sit in an engine build
    // for minutes, and there is otherwise no way out of it.
    if (isOpeningChainPreview) {
      addConsoleLog('Cancelled opening the chain preview');
      void cancelChainPreview();
      return;
    }
    if (chainPreviewOpen) {
      void closeChainPreview();
      return;
    }
    addConsoleLog('Opening the chain preview...');
    void openChainPreview();
  }, [isOpeningChainPreview, chainPreviewOpen, openChainPreview, closeChainPreview,
      cancelChainPreview, addConsoleLog]);

  /**
   * Play, opening the session first if there is not one.
   *
   * Playback needs the warm VapourSynth session that Inspect opens, but
   * making the user press Inspect before they can press play is a rule about
   * our plumbing, not about what they asked for. Pressing play opens it.
   *
   * The captured `play` stays valid across the await: everything it reads —
   * the port, the outputs, the playhead, the selected step — lives in refs,
   * and a failed or cancelled open leaves the port null so it does nothing.
   */
  const handleTogglePlayback = useCallback(() => {
    if (chainPreview.playback.isPlaying) {
      void chainPreview.playback.pause();
      return;
    }
    if (chainPreviewOpen) {
      chainPreview.playback.play();
      return;
    }
    if (isOpeningChainPreview) return;
    addConsoleLog('Opening the chain preview to play...');
    void openChainPreview().then(() => chainPreview.playback.play());
  }, [chainPreview.playback, chainPreviewOpen, isOpeningChainPreview,
      openChainPreview, addConsoleLog]);

  const handleSeekFrame = useCallback(async (frameNumber: number) => {
    if (!videoInfo) return;

    // With a session open the frame comes from the chain, not from ffmpeg.
    if (chainPreviewOpen) {
      seekChainPreview(frameNumber);
      setPlayheadFrame(frameNumber);
      return;
    }
    
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
  }, [videoInfo, updatePreviewFrame, chainPreviewOpen, seekChainPreview]);

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

  // Colour grading. The values live in the filter's parameters; the hook holds
  // the draft while a trackball is being dragged so history records one entry
  // per gesture rather than one per pixel of travel.
  const colorGrade = useColorGrade({
    filter: activeFilterEditor,
    onParametersChange: handleFilterParametersChange,
  });
  const [gradeCompareMode, setGradeCompareMode] = useState<CompareMode>('split');
  const [holdingBefore, setHoldingBefore] = useState(false);
  const [scopeSample, setScopeSample] = useState<Float32Array | null>(null);
  const [dockScope, setDockScope] = useState<ScopeKind>('parade');
  // The grading tools live in the dock, but their state lives here: the dock
  // and the viewer overlay both read it, and it has to survive the dock
  // remounting as the layout solver moves the tools between column and row.
  const [pickMode, setPickMode] = useState<PickMode>(null);
  const [showClipping, setShowClipping] = useState(false);
  const [toolsAvailable, setToolsAvailable] = useState({ canPick: false, canShowClipping: false });
  const [windowHeight, setWindowHeight] = useState(() => window.innerHeight);
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    const onResize = () => {
      setWindowHeight(window.innerHeight);
      setWindowWidth(window.innerWidth);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Grading is a mode, so it gets the window. A 16:9 window has no vertical
  // room to spare and the dock is the thing that needs width, so while a grade
  // is open the settings column folds to a strip and the preview column — dock
  // included — takes what it was using. One click brings the column back for
  // as long as this grade stays open.
  const [settingsRevealed, setSettingsRevealed] = useState(false);
  const gradeFocus = Boolean(colorGrade.editor) && !settingsRevealed;

  useEffect(() => {
    if (!colorGrade.editor) setSettingsRevealed(false);
  }, [colorGrade.editor]);

  // Where the scope column beside the picture gets its width, and why taking
  // it costs nothing. The picture is laid out object-contain, so in a pane
  // wider than the frame can use at that height the extra width goes nowhere.
  // In a 16:9 window it always is: the spare runs from 97px at 1200x675 to
  // 193px at 2560x1440 *beyond* the 380px the column asks for. So the column
  // is only ever offered out of width the picture had no use for, and it
  // disappears the moment that stops being true — a tall window, a portrait
  // source, or the settings column brought back over the top of a grade.
  // Dragged by hand this wins over the rule above, and is remembered. Null
  // means nobody has asked, so the spare-width rule keeps deciding — which is
  // also what double-clicking the handle puts it back to.
  const [scopeColumnOverride, setScopeColumnOverride] = useState<number | null>(() => {
    const stored = Number(window.localStorage.getItem('vk-scope-column-width'));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  });

  useEffect(() => {
    if (scopeColumnOverride === null) window.localStorage.removeItem('vk-scope-column-width');
    else window.localStorage.setItem('vk-scope-column-width', String(scopeColumnOverride));
  }, [scopeColumnOverride]);

  const gradePaneWidth = windowWidth - 63
    - (queueStore.showQueue ? 240 : 0)
    - (gradeFocus ? 34 : 5 + settingsWidth);

  const scopeColumnWidth = useMemo(() => {
    if (!colorGrade.editor) return 0;
    if (scopeColumnOverride !== null) {
      return clampScopeColumnWidth(scopeColumnOverride, gradePaneWidth);
    }
    const dockHeight = windowHeight < GRADE_COMPACT_BELOW ? GRADE_DOCK_COMPACT_HEIGHT : GRADE_DOCK_HEIGHT;
    const pictureHeight = windowHeight - (45 + 37 + dockHeight + 41) - 24;
    const aspect = cropSourceSize && cropSourceSize.height > 0
      ? cropSourceSize.width / cropSourceSize.height
      : 16 / 9;
    return solveScopeColumnWidth(gradePaneWidth, pictureHeight, aspect);
  }, [colorGrade.editor, scopeColumnOverride, gradePaneWidth, windowHeight, cropSourceSize]);

  // Making a table is a step in the chain, not a gesture over it: a Create LUT
  // remembers the colour where it sits, and a Load LUT below it makes the
  // table that puts that colour back. Import is the other direction and
  // cannot be a step's own doing, because a LUT is an arbitrary transform and
  // the trackballs are not — so an imported table arrives as a Load LUT step,
  // which is also what lets it sit anywhere in the chain like everything else.
  /**
   * Pick a table off disk and keep a normalised copy beside the app's data.
   *
   * The parse happens here rather than in the main process so this tested
   * parser is the only one, and so its "line 4: ..." reaches the person who
   * has to fix the file. A 1D table is lifted onto a lattice; .3dl and
   * declared domains are folded away, leaving one plain shape for the render.
   */
  const handlePickLutFile = useCallback(async (): Promise<{ path: string; title: string } | null> => {
    const source = await window.electronAPI.selectLutFile('open');
    if (!source) return null;

    const read = await window.electronAPI.readLutFile(source);
    if (!read.success) {
      notify.error('LUT not read', read.error);
      return null;
    }

    let normalised: string;
    let title: string;
    try {
      const parsed = to3d(parseLut(read.text, read.name));
      title = parsed.title || read.name.replace(/\.[^.]+$/, '');
      normalised = writeCube(parsed, title);
    } catch (error) {
      notify.error('That LUT could not be read', getErrorMessage(error));
      return null;
    }

    const installed = await window.electronAPI.installLut(read.name, normalised);
    if (!installed.success) {
      notify.error('LUT not read', installed.error);
      return null;
    }
    return { path: installed.path, title };
  }, []);

  const handleImportLut = useCallback(async () => {
    const template = filterTemplates.find(t => t.name === 'Load LUT');
    if (!template) {
      notify.error('Load LUT is missing', 'The Load LUT filter template is not installed.');
      return;
    }
    const installed = await handlePickLutFile();
    if (!installed) return;
    const title = installed.title;

    const defaults = Object.entries(template.variables ?? {}).reduce<Record<string, string | number | boolean>>(
      (values, [name, variable]) => {
        if (variable.default !== undefined) values[name] = variable.default;
        return values;
      }, {});

    const step: Filter = {
      id: `filter-${Date.now()}`,
      enabled: true,
      filterType: 'custom',
      preset: 'Load LUT',
      code: template.code,
      category: template.category,
      parameters: { ...defaults, lut_path: installed.path },
      variables: template.variables,
      editor: template.editor,
      order: filters.length,
    };

    // Straight after the grade it was imported from, so the chain reads in
    // the order the look was built.
    const at = filters.findIndex(filter => filter.id === activeFilterEditorId);
    const next = at === -1 ? [...filters, step] : [
      ...filters.slice(0, at + 1), step, ...filters.slice(at + 1),
    ];
    handleSetFilters(next.map((filter, index) => ({ ...filter, order: index })));
    notify.success('LUT imported', `"${title}" added to the chain as a Load LUT step.`);
  }, [activeFilterEditorId, filterTemplates, filters, handleSetFilters]);

  // The tables the chain's LUT steps ask for. Its own hook because it owns
  // two engines and a job per step, and App is long enough already. The
  // filter panel gets one object, so a memo'd panel is not re-rendered by a
  // fresh closure every time App is.
  const lutSteps = useLutSteps({
    filters,
    setFilters: handleSetFilters,
    videoInfo,
    segment,
    playheadFrame,
    currentWorkflow,
    samplePair: chainPreview.samplePair,
    previewOpen: chainPreview.isOpen,
    addConsoleLog,
  });
  const lutPanel = useMemo<LutPanelActions>(() => ({
    pickFile: async () => (await handlePickLutFile())?.path ?? null,
    restore: lutSteps.restore,
    bake: lutSteps.bake,
    clear: lutSteps.clear,
    jobs: lutSteps.jobs,
    previewOpen: chainPreview.isOpen,
  }), [handlePickLutFile, lutSteps, chainPreview.isOpen]);

  const gradeStepLabel = useMemo(() => {
    if (!colorGrade.editor || !activeFilterEditor) return '';
    const enabled = filters.filter(filter => filter.enabled);
    const position = enabled.findIndex(filter => filter.id === activeFilterEditor.id);
    const previous = position > 0 ? enabled[position - 1] : null;
    const previousName = previous?.preset
      || (previous?.modelPath ? getPortableModelName(previous.modelPath) : null);
    if (position < 0) return 'this step is disabled';
    return previousName
      ? `step ${position + 1} of ${enabled.length} · after ${previousName}`
      : `step ${position + 1} of ${enabled.length} · from the source`;
  }, [activeFilterEditor, colorGrade.editor, filters]);

  // With a grade step open, park the session on the step BELOW it. That frame
  // is the picture entering the grade, and the shader applies the grade to it
  // on the GPU — so a trackball drag costs a draw call, not a script reload.
  // Selecting the grade's own output would show the values that were baked
  // into the script when it loaded, which is exactly the stale picture.
  // Both pickers solve the primaries ramp, not the final pixel, so contrast,
  // gamma and brightness still do what they were set to afterwards — which is
  // what a black or white point means in Resolve too.
  const handlePick = useCallback((sample: [number, number, number]) => {
    const wanted = pickMode;
    // One solve per arming, so a stray second click cannot re-solve against
    // the picture the first one just changed.
    setPickMode(null);
    if (!wanted) return;

    if (wanted === 'black') {
      const solved = solveBlackPoint(colorGrade.values, sample);
      if (!solved) {
        notify.warning(
          'Too bright for a black point',
          'That pixel is too far up the range to sit at black. Pick something in the shadows.',
        );
        return;
      }
      colorGrade.apply(solved.values);
      if (solved.clamped) {
        notify.info(
          'Black point set, partly',
          'The colour cast in those shadows is stronger than the lift ball can correct on its own.',
        );
      } else {
        addConsoleLog('Black point set from the picture');
      }
      return;
    }

    if (wanted === 'white') {
      const solved = solveWhitePoint(colorGrade.values, sample);
      if (!solved) {
        notify.warning(
          'Too dark for a white point',
          'That pixel is too far down the range to sit at white. Pick something in the highlights.',
        );
        return;
      }
      colorGrade.apply(solved.values);
      if (solved.clamped) {
        notify.info(
          'White point set, partly',
          'The colour cast in those highlights is stronger than the gain ball can correct on its own.',
        );
      } else {
        addConsoleLog('White point set from the picture');
      }
      return;
    }

    // Neutral is the odd one out: it writes the two tone sliders rather than a
    // ball, because temperature and tint are where a colour cast is stored.
    const solved = solveNeutral(colorGrade.values, sample);
    if (!solved) {
      notify.warning(
        'Nothing to balance there',
        'That pixel sits too near black or white to carry a cast. Pick something in the midtones.',
      );
      return;
    }
    colorGrade.apply(solved.values);
    if (solved.clamped) {
      notify.info(
        'Balanced, partly',
        'That cast runs further than temperature and tint reach. What is left is not a white balance error.',
      );
    } else {
      addConsoleLog(
        `Neutral picked — ${solved.values.temperature.toFixed(0)}K, tint ${solved.values.tint.toFixed(1)}`,
      );
    }
  }, [pickMode, colorGrade, addConsoleLog]);

  // Reads the two ends off the scope sample — the same 240px buffer the scopes
  // already grade, so this costs no extra readback — and solves lift and gain
  // together against them.
  const handleAutoBalance = useCallback(() => {
    const solved = autoBalance(colorGrade.values, scopeSample);
    if (!solved) {
      notify.warning(
        'Nothing to balance',
        'This frame has no usable range to read a black and a white off. Try a frame with more in it.',
      );
      return;
    }

    colorGrade.apply(solved.values);
    if (!solved.solved.black || !solved.solved.white) {
      // Half an answer is still worth having, but saying so is the difference
      // between a tool that missed and a tool that looks broken.
      const end = solved.solved.black ? 'black' : 'white';
      notify.info(
        `Only the ${end} point was set`,
        'The picture does not reach far enough the other way for both ends to be solved.',
      );
    } else if (solved.clamped) {
      notify.info(
        'Balanced, partly',
        'The cast in this frame is stronger than the lift and gain balls can correct on their own.',
      );
    } else {
      addConsoleLog('Auto balance set the black and white points from the frame');
    }
  }, [colorGrade, scopeSample, addConsoleLog]);

  // The panel reports on every frame change, so this only stores an answer
  // that actually changed — otherwise a new object each time would re-render
  // the whole grading surface behind every preview frame.
  const handleToolAvailability = useCallback((next: { canPick: boolean; canShowClipping: boolean }) => {
    setToolsAvailable(current =>
      current.canPick === next.canPick && current.canShowClipping === next.canShowClipping
        ? current
        : next);
  }, []);

  // A picker armed against a picture it can no longer be used on is a click
  // that will never land, so the panel's answer disarms it.
  useEffect(() => {
    if (!toolsAvailable.canPick) setPickMode(null);
  }, [toolsAvailable.canPick]);

  // Two groups, not one, because they are two kinds of thing. The viewer
  // controls change how the picture is shown and ride the step rail above it;
  // the tool rail changes what a click on the picture does. Auto balance is
  // neither — it is a command, and it goes to the dock header beside Reset all.
  const viewerControls = useMemo<ViewerControls>(() => ({
    compareMode: gradeCompareMode,
    onCompareModeChange: setGradeCompareMode,
    holdingBefore,
    showClipping,
    onShowClippingChange: setShowClipping,
    canShowClipping: toolsAvailable.canShowClipping,
    // Only a session can offer a choice: without one there is a single frame,
    // and the only "before" available is that frame ungraded.
    reference: chainPreview.isOpen
      ? {
          steps: chainPreview.steps.map(step => ({ index: step.index, label: step.label })),
          pinned: chainPreview.reference,
          onPin: chainPreview.setReference,
        }
      : null,
  }), [
    gradeCompareMode, holdingBefore, showClipping, toolsAvailable.canShowClipping,
    chainPreview.isOpen, chainPreview.steps, chainPreview.reference, chainPreview.setReference,
  ]);

  const toolRail = useMemo<ToolRailControls>(() => ({
    pickMode,
    onPickModeChange: setPickMode,
    canPick: toolsAvailable.canPick,
  }), [pickMode, toolsAvailable.canPick]);

  const gradeUpstreamOutput = useMemo(() => {
    if (!colorGrade.editor || !activeFilterEditor) return null;
    const enabled = filters.filter(filter => filter.enabled).sort((a, b) => a.order - b.order);
    const position = enabled.findIndex(filter => filter.id === activeFilterEditor.id);
    // Output 0 is the source, so the filter at position p produces output
    // p + 1 and receives output p.
    return position < 0 ? null : position;
  }, [colorGrade.editor, activeFilterEditor, filters]);

  const lastChainStep = chainPreview.steps.length
    ? chainPreview.steps[chainPreview.steps.length - 1].index
    : null;

  // Park once per open editor, rather than on a transition.
  //
  // Watching for a change in the step was wrong in a way that showed up only
  // in the ordering people actually use: opening takes a moment, and anything
  // that set the grade step while the session was still opening left the
  // before and after values equal by the time it was open. The effect then
  // concluded nothing had changed and never selected anything, so the session
  // sat on the last step until a tab was clicked by hand.
  //
  // Keyed on the editor instead, both orderings park exactly once, and a step
  // chosen by hand afterwards is left alone.
  const parkedForRef = useRef<string | null>(null);
  const parkKey = gradeUpstreamOutput === null
    ? null
    : `${activeFilterEditorId}:${gradeUpstreamOutput}`;

  useEffect(() => {
    if (!chainPreviewOpen) {
      parkedForRef.current = null;
      return;
    }

    if (parkKey === null) {
      // The grade closed, so show the whole chain again — once.
      if (parkedForRef.current !== null && lastChainStep !== null) {
        parkedForRef.current = null;
        selectChainStep(lastChainStep);
      }
      return;
    }

    if (parkedForRef.current === parkKey) return;
    parkedForRef.current = parkKey;
    selectChainStep(gradeUpstreamOutput!);
  }, [chainPreviewOpen, parkKey, gradeUpstreamOutput, lastChainStep, selectChainStep]);

  useEffect(() => {
    if (!activeFilterEditorId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActiveFilterEditorId(null);
      // Hold to see the frame entering this step. Ignored while typing, so a
      // "b" in the code editor or a filename never flickers the preview.
      const target = event.target as HTMLElement | null;
      const typing = target && (target.isContentEditable
        || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      if (!typing && (event.key === 'b' || event.key === 'B')) setHoldingBefore(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'b' || event.key === 'B') setHoldingBefore(false);
    };
    // A window that loses focus mid-hold would otherwise stay stuck on "before".
    const onBlur = () => setHoldingBefore(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [activeFilterEditorId]);

  useEffect(() => {
    if (!colorGrade.editor) setHoldingBefore(false);
  }, [colorGrade.editor]);

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

  // A visual editor owns the preview pane, and processing wants it back: the
  // dock disables itself the moment a run starts, so an editor left open is
  // one you are locked out of, sitting on top of the frames you want to
  // watch. Guarded on isProcessing, because this must never reach the Stop
  // the same button turns into.
  const startBlockedByEditor = !isProcessing && Boolean(activeFilterEditorId);

  const isStartDisabled = (() => {
    // Disable if stopping
    if (isStopping) return true;
    if (startBlockedByEditor) return true;

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
        setupError={setupError}
        setupWarnings={setupWarnings}
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

        {/* Notification Bar for a missing DLSS 5 runtime */}
        <DlssRuntimeNotification filters={filters} />

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
                    gradePreview={colorGrade.editor ? {
                      values: colorGrade.values,
                      mode: gradeCompareMode,
                      holdingBefore,
                      stepLabel: gradeStepLabel,
                      pickMode,
                      showClipping,
                      viewer: viewerControls,
                      toolRail,
                      onPick: handlePick,
                      onAvailabilityChange: handleToolAvailability,
                    } : null}
                    onFrameSampled={setScopeSample}
                    scopeSample={scopeSample}
                    scopeColumnWidth={scopeColumnWidth}
                    onScopeColumnResize={(width) =>
                      setScopeColumnOverride(clampScopeColumnWidth(width, gradePaneWidth))}
                    onScopeColumnReset={() => setScopeColumnOverride(null)}
                    gradeBasePx={gradeBasePx(gradePaneWidth, windowHeight < GRADE_COMPACT_BELOW)}
                    chainPreview={chainPreview.isOpen ? {
                      steps: chainPreview.steps,
                      selected: chainPreview.selected,
                      frame: chainPreview.frame,
                      isRendering: chainPreview.isRendering,
                      isStale: chainPreview.isStale,
                      isPlaying: chainPreview.playback.isPlaying,
                      frameSource: chainPreview.playback,
                      liveGradeStep: gradeUpstreamOutput,
                      referenceFrame: chainPreview.referenceFrame,
                      referenceLabel: chainPreview.reference === null
                        ? null
                        : chainPreview.steps.find(s => s.index === chainPreview.reference)?.label ?? null,
                      // The grade's own output and everything above it were
                      // built with the values the script loaded with.
                      bakedFromStep: gradeUpstreamOutput === null ? null : gradeUpstreamOutput + 1,
                      onSelect: chainPreview.select,
                      onReload: () => void chainPreview.open(),
                    } : null}
                  />

                  {colorGrade.editor && (
                    <ColorGradeDock
                      values={colorGrade.values}
                      scopeSample={scopeSample}
                      stepLabel={gradeStepLabel}
                      compact={windowHeight < GRADE_COMPACT_BELOW}
                      scopesInColumn={scopeColumnWidth > 0}
                      disabled={isProcessing}
                      dockScope={dockScope}
                      onDockScopeChange={setDockScope}
                      onAutoBalance={handleAutoBalance}
                      canAutoBalance={scopeSample !== null}
                      onImportLut={handleImportLut}
                      onChange={colorGrade.setValues}
                      onCommit={colorGrade.commit}
                      onApply={colorGrade.apply}
                    />
                  )}

                  <Scrubber
                    videoInfo={videoInfo}
                    segment={segment}
                    isProcessing={isProcessing}
                    playhead={playheadFrame}
                    onSegmentChange={handleSegmentChange}
                    onSeekFrame={handleSeekFrame}
                    // Always present, disabled until there is something to
                    // play. Withholding the transport until a video loads
                    // left a hole where it belongs and shifted the whole bar
                    // sideways the moment one arrived.
                    playback={{
                      isPlaying: chainPreview.playback.isPlaying,
                      isOpening: isOpeningChainPreview,
                      targetFps: chainPreview.playback.targetFps,
                      achievedFps: chainPreview.playback.achievedFps,
                      behind: chainPreview.playback.behind,
                      onToggle: handleTogglePlayback,
                      onPause: () => { void chainPreview.playback.pause(); },
                      loop: chainPreview.playback.loop,
                      onLoopChange: chainPreview.playback.setLoop,
                    }}
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
                  gradeFocus ? 'hidden' : ''
                } ${isResizingSettings ? 'bg-accent-500/30' : 'hover:bg-accent-500/20'}`}
              >
                <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-ink-800" aria-hidden="true" />
              </div>

              {/* Folded settings — the grade has the window; this brings it back */}
              {gradeFocus && (
                <button
                  type="button"
                  onClick={() => setSettingsRevealed(true)}
                  title="Show the settings column"
                  aria-label="Show the settings column"
                  className="w-[34px] flex-shrink-0 flex flex-col items-center gap-2 py-2.5 bg-ink-900 border-l border-ink-800 text-ink-500 hover:text-ink-200 hover:bg-ink-850 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-inset"
                >
                  <ChevronLeft className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
                  <span className="font-display text-[10px] font-semibold uppercase tracking-[0.16em] [writing-mode:vertical-rl]">
                    Settings
                  </span>
                </button>
              )}

              {/* Settings column — pixel width, dragged at its left edge */}
                <div ref={rightPanelRef} style={{ width: settingsWidth }} className={`flex-shrink-0 flex-col overflow-y-auto overflow-x-hidden min-h-0 bg-ink-950 ${gradeFocus ? 'hidden' : 'flex'}`}>
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
                    onRestoreTemplates={restoreTemplates}
                    onOpenFilterEditor={handleOpenFilterEditor}
                    lut={lutPanel}
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
          startDisabledReason={startBlockedByEditor
            ? 'Close the editor above the preview before processing'
            : undefined}
          upscaleProgress={upscaleProgress}
          isValidating={isValidating}
          validationStatus={validationStatus}
          validationError={validationError}
          validateWorkflow={validateWorkflow}
          cancelValidation={cancelValidation}
          isLaunchingPreviewer={isLaunchingPreviewer}
          chainPreviewOpen={chainPreview.isOpen}
          isOpeningChainPreview={isOpeningChainPreview}
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
          handleToggleChainPreview={handleToggleChainPreview}
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
        onOpenUpdateReport={() => setShowUpdateReport(true)}
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
        showUpdateReport={showUpdateReport}
        onCloseUpdateReport={() => closeModalWithFocusRestore(() => setShowUpdateReport(false))}
        importModalState={importModalState}
        closeImportModal={closeImportModal}
        confirmImportFilters={confirmImportFilters}
      />
    </div>
  );
}

export default App;
