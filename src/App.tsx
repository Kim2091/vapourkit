// src/App.tsx - Refactored with extracted components and hooks

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { NotificationContainer } from './components/NotificationContainer';
import { ConfirmDialogHost } from './components/ConfirmDialogHost';
import { notify } from './utils/notifications';
import { QueuePanel } from './components/QueuePanel';
import { AppModals } from './components/AppModals';
import { ActionBar } from './components/ActionBar';
import { ConsoleDrawer } from './components/ConsoleDrawer';
import { Scrubber } from './components/Scrubber';
import { EngineBuildBanner } from './components/EngineBuildBanner';
import type { BackendId, ColorimetrySettings, EngineBuildStatus, UpdateInfo, SegmentSelection, VsMlrtVersionInfo, Filter, FilterParameterValues } from './electron';
import { getBackendDescriptor, normalizeBackendForCurrentPlatform, resolveFilterBackend } from './utils/backends';
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
import { ColorGradeDock, GRADE_COMPACT_BELOW } from './components/ColorGradeDock';
import { clampScopeColumnWidth } from './components/GradeScopeColumn';
import { gradeBasePx } from './components/gradeType';
import { useLutSteps } from './hooks/useLutSteps';
import type { LutPanelActions } from './components/DynamicFilterPanel';
import { useChainPreview } from './hooks/useChainPreview';
import { VideoInputPanel } from './components/VideoInputPanel';
import { VideoInfoPanel } from './components/VideoPanel';
import { OutputSettingsPanel } from './components/OutputSettingsPanel';
import { ModelSelectionPanel } from './components/ModelSelectionPanel';
import { getPortableModelName } from './utils/modelUtils';
import { useAccentColor } from './hooks/useAccentColor';
import { useMainColor } from './hooks/useMainColor';
import { useDiscordRichPresence } from './hooks/useDiscordRichPresence';
import { useDiscordActivity } from './hooks/useDiscordActivity';
import { useGpuStats } from './hooks/useGpuStats';
import { useResizableColumn } from './hooks/useResizableColumn';
import { useGradeWorkspace } from './hooks/useGradeWorkspace';
import { useLutImport } from './hooks/useLutImport';
import { projectOutputOverride, type QueueSession } from './utils/projectSnapshot';
import { useWorkflowDocument } from './hooks/useWorkflowDocument';
import { viewOf } from './utils/workflowDocument';
import { toQueueWorkflow, WHOLE_VIDEO } from './utils/workflowSettings';

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
  const gpuStats = useGpuStats();

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

  // An NVIDIA driver too old for the bundled FFmpeg's NVENC fails every NVENC
  // encode before its first frame, so say so at launch. Raised once the main
  // screen is up: the notification container only mounts with it.
  const nvencCheckedRef = useRef(false);
  useEffect(() => {
    if (nvencCheckedRef.current || isCheckingDeps || !isSetupComplete) return;
    nvencCheckedRef.current = true;
    window.electronAPI.getNvencDriverProblem()
      .then(problem => {
        if (problem) {
          addConsoleLog(problem);
          notify.warning('NVIDIA Driver Too Old for NVENC', problem);
        }
      })
      .catch(() => { /* the check is advisory */ });
  }, [isCheckingDeps, isSetupComplete, addConsoleLog]);
  const { showBackendOverrides, setShowBackendOverrides } = useSettings();
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
    defaultOutputFolder,
    descriptiveNamingEnabled,
    handleUpdateDefaultOutputFolder,
    handleResetDefaultOutputFolder,
    handleUpdateDescriptiveNamingEnabled,
  } = useProcessingConfig(isSetupComplete);

  // Queue store (data + UI state)
  const outputNaming = useMemo(
    () => ({ defaultOutputFolder, descriptive: descriptiveNamingEnabled }),
    [defaultOutputFolder, descriptiveNamingEnabled],
  );
  const queueStore = useQueueStore({ onLog: addConsoleLog, naming: outputNaming });

  // The workflow settings the window works on: the project's, or the queue
  // item being edited, whose edits are saved to the item.
  const workflow = useWorkflowDocument({
    isSetupComplete,
    recommendedBackend,
    onLog: addConsoleLog,
    onItemChange: queueStore.updateItemWorkflow,
  });
  const {
    selectedModel,
    ffmpegArgs,
    processingFormat,
    outputFormat,
    videoCompareArgs,
    defaultBackend,
    numStreams,
    segment,
    colorimetry: colorimetrySettings,
  } = workflow.view;
  const { patch: patchWorkflow } = workflow;
  const setSelectedModel = useCallback((model: string | null) => patchWorkflow({ selectedModel: model }), [patchWorkflow]);
  const handleUpdateFfmpegArgs = useCallback((args: string) => patchWorkflow({ ffmpegArgs: args }), [patchWorkflow]);
  const handleUpdateProcessingFormat = useCallback((format: string) => patchWorkflow({ processingFormat: format }), [patchWorkflow]);
  const handleUpdateOutputFormat = useCallback((format: string) => patchWorkflow({ outputFormat: format }), [patchWorkflow]);
  const handleUpdateVideoCompareArgs = useCallback((args: string) => patchWorkflow({ videoCompareArgs: args }), [patchWorkflow]);
  const handleResetVideoCompareArgs = useCallback(async () => {
    try {
      const result = await window.electronAPI.getDefaultVideoCompareArgs();
      patchWorkflow({ videoCompareArgs: result.args });
    } catch (error) {
      console.error('Error resetting video compare args:', error);
    }
  }, [patchWorkflow]);
  const setDefaultBackend = useCallback(
    (backend: BackendId) => patchWorkflow({ defaultBackend: normalizeBackendForCurrentPlatform(backend) }),
    [patchWorkflow],
  );
  const updateNumStreams = useCallback((streams: number) => patchWorkflow({ numStreams: streams }), [patchWorkflow]);
  const setSegment = useCallback((next: SegmentSelection) => patchWorkflow({ segment: next }), [patchWorkflow]);
  const handleColorimetryChange = useCallback((settings: ColorimetrySettings) => {
    patchWorkflow({ colorimetry: settings });
    addConsoleLog(`Colorimetry settings updated: ${settings.overwriteMatrix ? (settings.matrix709 ? 'BT.709' : 'BT.601') : 'disabled'}`);
  }, [patchWorkflow, addConsoleLog]);

  // Model management hooks
  const {
    availableModels,
    loadModels,
    loadUninitializedModels,
    uninitializedModels,
  } = useModels(isSetupComplete, {
    get: () => viewOf(workflow.getState()).selectedModel,
    set: setSelectedModel,
  });
  const { templates: filterTemplates, saveTemplate, deleteTemplate, restoreTemplates, loadTemplates } = useFilterTemplates(isSetupComplete);

  // State management hooks
  const {
    filters, handleSetFilters, beginStepPatch, chainEpoch,
    canUndo, canRedo, handleUndo, handleRedo,
  } = useFilterConfig(workflow, isSetupComplete, addConsoleLog);
  const [activeFilterEditorId, setActiveFilterEditorId] = useState<string | null>(null);
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

  // Video processing hooks
  const {
    videoInfo,
    setVideoInfo,
    outputPath: projectOutputPath,
    outputPathOverride,
    setOutputPathOverride,
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
    colorimetry: colorimetrySettings,
    segment,
  });

  useDiscordActivity({
    isSetupComplete,
    privacyMode,
    isProcessing,
    upscaleProgress,
    videoInfo,
    publishDiscordRichPresence,
    clearDiscordRichPresence,
  });
  
  // Destructure queue store for convenience
  const {
    queue,
    addToQueue,
    removeFromQueue,
    updateQueueItem,
    clearQueue,
    clearCompletedItems,
    reorderQueue,
    requeueItem,
    duplicateQueueItem,
  } = queueStore;

  // While a queue item is shown the window shows the file that item writes.
  const shownItem = workflow.shownItemId
    ? queue.find(item => item.id === workflow.shownItemId)
    : undefined;
  const outputPath = shownItem ? shownItem.outputPath : projectOutputPath;

  const handleSelectOutputFileForView = async (): Promise<void> => {
    if (!shownItem) {
      await handleSelectOutputFile();
      return;
    }
    // A queue item that has started or finished keeps the file it was given.
    if (shownItem.id !== workflow.editingItemId) return;
    try {
      const selected = await window.electronAPI.selectOutputFile(shownItem.outputPath);
      if (selected) {
        updateQueueItem(shownItem.id, { outputPath: selected, customOutputPath: true });
        addConsoleLog(`Output path for queue item: ${selected}`);
      }
    } catch (error) {
      addConsoleLog(`Error: ${getErrorMessage(error)}`);
    }
  };

  /** Load a video into the project. A different video starts with the whole of it selected. */
  const loadProjectVideo = async (path: string): Promise<void> => {
    const previousPath = videoInfo?.path;
    await loadVideoInfo(path);
    if (path !== previousPath) setSegment(WHOLE_VIDEO);
  };

  // Batch configuration hook
  const {
    handleSelectVideoWithQueue,
    handleBatchFiles,
    handleAddCurrentVideoToQueue,
  } = useBatchConfig({
    getWorkflow: () => toQueueWorkflow(viewOf(workflow.getState())),
    showQueue: queueStore.showQueue,
    onAddToQueue: (videoPaths, itemWorkflow, output) => {
      addToQueue(videoPaths, itemWorkflow, output);
      // Adding several videos opens the queue; it has to set the project's
      // video aside like the queue button does, or closing it has nothing to put back.
      openQueue();
    },
    onLoadVideoInfo: loadProjectVideo,
    onLog: addConsoleLog,
  });

  // Queue operations hook
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
    openItem: workflow.openItem,
    pendingItemSave: workflow.pendingItemSave,
    runningItemId: queueStore.runningItemId,
    setRunStatus: queueStore.setRunStatus,
    updateQueueItem,
    flushQueue: queueStore.flushQueue,
    requeueItem,
    loadVideoInfo,
    handleCancelUpscale,
    onLog: addConsoleLog,
    loadCompletedVideo,
    setCompletedVideoPath,
  });

  // Queue processing effects
  useQueueProcessing({
    queue,
    runStatus: queueStore.runStatus,
    setRunStatus: queueStore.setRunStatus,
    runningItemId: queueStore.runningItemId,
    setRunningItemId: queueStore.setRunningItemId,
    upscaleProgress,
    updateQueueItem,
    beginItemRender: workflow.beginItemRender,
    endItemRender: workflow.endItemRender,
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
    settings: workflow.view,
    patch: patchWorkflow,
    addConsoleLog,
    filterTemplates,
    refreshFilterTemplates: loadTemplates,
    // A workflow loaded into a queue item is that item's to clear, not the project's.
    context: workflow.shownItemId ?? 'project',
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
  
  // Whether the queue is open, as of the last open or close asked for. The
  // state only flips a render later, and adding several videos asks once per
  // video, so this is what keeps the project from being set aside twice.
  const queueOpenRef = useRef(false);
  useEffect(() => {
    queueOpenRef.current = queueStore.showQueue;
  }, [queueStore.showQueue]);

  /**
   * Open the queue, setting the project's video aside to be put back when it
   * closes: editing a queue item shows that item's video. The project's
   * settings need no setting aside, since editing an item never touches them.
   * Every way of opening the queue comes through here.
   */
  const openQueue = (options: { addCurrentVideo?: boolean } = {}) => {
    if (queueOpenRef.current) return;
    queueOpenRef.current = true;
    workflow.openSession({
      videoPath: videoInfo?.path || null,
      outputPath: projectOutputPath || null,
      outputPathOverride,
    });
    queueStore.setShowQueue(true);

    // If a video is loaded, add it to the queue
    if (options.addCurrentVideo && videoInfo && projectOutputPath) {
      handleAddCurrentVideoToQueue(videoInfo.path, { path: projectOutputPath, custom: outputPathOverride !== null });
    }
  };

  /** Put the project's video back in the window, with the output path it had. */
  const restoreProjectVideo = async (session: QueueSession) => {
    if (!session.videoPath) {
      setVideoInfo(null);
      setOutputPathOverride(null);
      return;
    }
    try {
      const info = await loadVideoInfo(session.videoPath);
      setOutputPathOverride(projectOutputOverride(session, info, workflow.getState().project, outputNaming));
    } catch (error) {
      addConsoleLog(`Could not reload the project's video: ${getErrorMessage(error)}`);
    }
  };

  /** Show the project again: its settings, and its video when another is in the window. */
  const showProject = async () => {
    workflow.showProject();
    const session = workflow.getState().session;
    if (session && session.videoPath !== (videoInfo?.path ?? null)) await restoreProjectVideo(session);
  };

  /** Close the queue and put the project's video back as it was when the queue opened. */
  const closeQueue = async () => {
    queueOpenRef.current = false;
    const session = workflow.getState().session;
    workflow.showProject();
    queueStore.setShowQueue(false);
    workflow.closeSession();
    if (session) await restoreProjectVideo(session);
  };

  const handleToggleQueue = async () => {
    if (queueStore.showQueue) await closeQueue();
    else openQueue({ addCurrentVideo: true });
  };

  // The queue item shown stopped being what it was opened as: an edited item
  // started processing (it is encoded with the settings it had then, so later
  // edits would describe a render that never ran), or it was removed. Show the
  // project, which is what the open queue shows when nothing is being edited.
  // A finished item shown and then requeued can be edited from here on.
  const shownItemStatus = shownItem?.status ?? (workflow.shownItemId ? 'removed' : null);
  const shownItemEditable = workflow.editingItemId !== null;
  useEffect(() => {
    if (!shownItemStatus) return;
    if (shownItemStatus === (shownItemEditable ? 'pending' : 'completed')) return;
    if (shownItem && !shownItemEditable && shownItemStatus === 'pending') {
      workflow.openItem(shownItem.id, shownItem.workflow, true);
      return;
    }
    addConsoleLog(shownItemStatus === 'removed'
      ? 'The queue item shown was removed; showing the project'
      : shownItemStatus === 'processing'
        ? 'The queue item being edited has started processing; showing the project'
        : 'The queue item shown changed status; showing the project');
    void showProject();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownItemStatus, shownItemEditable]);

  // A restart in the middle of editing a queue item goes back to editing it,
  // once the queue and the saved settings have loaded; if it can no longer be
  // edited, the project is shown. A pre-queue record left with the queue
  // closed has nothing to put back.
  const resumeTriedRef = useRef(false);
  useEffect(() => {
    if (resumeTriedRef.current) return;
    if (!isSetupComplete || queueStore.isLoadingQueue || !queueStore.isShowQueueLoaded || !workflow.isLoaded) return;
    resumeTriedRef.current = true;

    if (!queueStore.showQueue) workflow.closeSession();
    const id = workflow.resumeEditingId;
    if (!id) return;
    const item = queue.find(candidate => candidate.id === id);
    if (queueStore.showQueue && item?.status === 'pending') {
      addConsoleLog(`Resumed editing queue item: ${item.videoName}`);
      void handleSelectQueueItem(id);
      return;
    }
    workflow.forgetResume();
  });

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

  // Settings column width — pixel-based drag on its left edge, persisted.
  const {
    width: settingsWidth,
    isResizing: isResizingSettings,
    handleResizeStart: handleSettingsResizeStart,
  } = useResizableColumn();

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


  const {
    colorGrade,
    gradeCompareMode,
    holdingBefore,
    scopeSample,
    setScopeSample,
    dockScope,
    setDockScope,
    pickMode,
    showClipping,
    windowHeight,
    gradeFocus,
    setSettingsRevealed,
    scopeColumnWidth,
    setScopeColumnOverride,
    gradePaneWidth,
    gradeStepLabel,
    handlePick,
    handleAutoBalance,
    handleToolAvailability,
    viewerControls,
    toolRail,
    gradeUpstreamOutput,
  } = useGradeWorkspace({
    activeFilterEditor,
    activeFilterEditorId,
    setActiveFilterEditorId,
    onParametersChange: handleFilterParametersChange,
    filters,
    chainPreview,
    cropSourceSize,
    showQueue: queueStore.showQueue,
    settingsWidth,
    addConsoleLog,
  });

  const { handlePickLutFile, handleImportLut } = useLutImport({
    filterTemplates,
    filters,
    activeFilterEditorId,
    handleSetFilters,
  });

  // The tables the chain's LUT steps ask for. Its own hook because it owns
  // two engines and a job per step, and App is long enough already. The
  // filter panel gets one object, so a memo'd panel is not re-rendered by a
  // fresh closure every time App is.
  const lutSteps = useLutSteps({
    filters,
    beginStepPatch,
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


  // Determine if processing should be disabled
  // Console drawer — stable identities so the memoised bar and drawer don't
  // re-render on every parent tick.
  const handleToggleConsole = useCallback(() => setShowConsole(!showConsole), [showConsole, setShowConsole]);
  const handleCloseConsole = useCallback(() => setShowConsole(false), [setShowConsole]);

  // Determine if processing should be disabled
  // With the queue a persistent selectable list, the Source header states
  // which item these settings apply to — the old editing banner is gone.
  const queueEditingLabel = (() => {
    if (!workflow.editingItemId) return undefined;
    const index = queue.findIndex(q => q.id === workflow.editingItemId);
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
      <ConfirmDialogHost privacyMode={privacyMode} />

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
              editingItemId={workflow.editingItemId}
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
                    beginStepPatch={beginStepPatch}
                    chainEpoch={chainEpoch}
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
                    onSelectOutputFile={handleSelectOutputFileForView}
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
