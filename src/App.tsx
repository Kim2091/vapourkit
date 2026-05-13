// src/App.tsx - Refactored with extracted components and hooks

import { useState, useEffect, useRef, useCallback } from 'react';
import { NotificationContainer } from './components/NotificationContainer';
import { notify } from './utils/notifications';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { QueuePanel } from './components/QueuePanel';
import { AppModals } from './components/AppModals';
import { ProgressPanel } from './components/ProgressPanel';
import { ActionButtons } from './components/ActionButtons';
import type { UpdateInfo, SegmentSelection, VsMlrtVersionInfo } from './electron';
import { Header } from './components/Header';
import { ModelBuildNotification } from './components/ModelBuildNotification';
import { useModels } from './hooks/useModels';
import { useSettings } from './hooks/useSettings';
import { usePrivacyMode } from './hooks/usePrivacyMode';
import { PrivacyText } from './components/PrivacyVeil';
import { useConsoleLog } from './hooks/useConsoleLog';
import { useModelImport } from './hooks/useModelImport';
import { useVideoDragDrop } from './hooks/useVideoDragDrop';
import { useFilterTemplates } from './hooks/useFilterTemplates';
import { useWorkflow } from './hooks/useWorkflow';
import { useSetup } from './hooks/useSetup';
import { useVideoProcessing } from './hooks/useVideoProcessing';
import { usePanelLayout } from './hooks/usePanelLayout';
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

  // Setup and initialization hooks
  const { consoleOutput, consoleEndRef, addConsoleLog } = useConsoleLog();
  const { isSetupComplete, isCheckingDeps, hasCudaSupport, setupProgress, isSettingUp, handleSetup, pluginInstallError, handleRetryPlugins, handleContinueWithoutPlugins } = useSetup(addConsoleLog);
  const { useDirectML, toggleDirectML, numStreams, updateNumStreams } = useSettings(hasCudaSupport);
  const { privacyMode, togglePrivacyMode } = usePrivacyMode();
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
  const { colorimetrySettings, handleColorimetryChange } = useColorimetry(isSetupComplete, addConsoleLog);
  const { panelSizes, panelSizesLoaded, handlePanelResize } = usePanelLayout(isSetupComplete, addConsoleLog);
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
    useDirectML: boolean;
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
    useDirectML,
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
    useDirectML,
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
    toggleDirectML,
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
    useDirectML,
    numStreams,
    segment,
    colorimetry: colorimetrySettings,
    setFfmpegArgs: handleUpdateFfmpegArgs,
    setProcessingFormat: handleUpdateProcessingFormat,
    setOutputFormat: handleUpdateOutputFormat,
    setVideoCompareArgs: handleUpdateVideoCompareArgs,
    toggleDirectML,
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
  } = useModelImport(useDirectML, async (enginePath?: string) => {
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
    useDirectML,
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
        useDirectML,
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
        if (preQueueWorkflow.useDirectML !== useDirectML) {
          toggleDirectML(preQueueWorkflow.useDirectML);
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
    useDirectML,
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
  }, [filters, selectedModel, useDirectML, numStreams, videoInfo?.path, clearValidationStatus]);

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

  const handleToggleDirectML = (value: boolean): void => {
    toggleDirectML(value);
    addConsoleLog(`Inference backend changed to: ${value ? 'DirectML (ONNX Runtime)' : 'TensorRT'}`);
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
        useDirectML,
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
  }, [videoInfo, selectedModel, useDirectML, filters, numStreams, addConsoleLog, loadCompletedVideo, setCompletedVideoPath]);

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
        useDirectML,
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
  }, [videoInfo, selectedModel, useDirectML, filters, numStreams, segment, addConsoleLog, isLaunchingPreviewer]);

  // Seek to a specific frame in the video preview (used by segment selector)
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
      }
    } catch (error) {
      // Silently fail - frame extraction is non-critical
      console.warn('Failed to extract frame:', error);
    }
  }, [videoInfo, updatePreviewFrame]);

  // Determine if processing should be disabled
  const isStartDisabled = (() => {
    // Disable if stopping
    if (isStopping) return true;

    // Basic validation - benchmark mode doesn't need outputPath
    if (!videoInfo) return true;
    if (!benchmarkMode && !outputPath) return true;
    
    // Prevent processing if using TensorRT mode with ONNX models
    if (!useDirectML) {
      // Check AI model filters for unbuilt ONNX models
      const hasOnnxModel = filters.some(f => 
        f.enabled && 
        f.filterType === 'aiModel' && 
        f.modelPath && 
        f.modelPath.toLowerCase().endsWith('.onnx')
      );
      if (hasOnnxModel) return true;
    }
    
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
    <div className="h-screen flex flex-col bg-gradient-to-br from-dark-bg via-dark-surface to-dark-bg overflow-hidden">
      <NotificationContainer />
      {/* Header */}
      <Header
        isProcessing={isProcessing}
        useDirectML={useDirectML}
        privacyMode={privacyMode}
        onTogglePrivacyMode={togglePrivacyMode}
        onSettingsClick={() => setShowSettings(true)}
        onPluginsClick={() => setShowPlugins(true)}
        onReloadBackend={handleReloadBackend}
        onAboutClick={() => setShowAbout(true)}
        onToggleDirectML={handleToggleDirectML}
        onLoadWorkflow={handleLoadWorkflow}
        onImportWorkflow={handleImportWorkflow}
        onExportWorkflow={handleExportWorkflow}
        onClearWorkflow={handleClearWorkflow}
        workflowName={currentWorkflow}
        isReloading={isReloading}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={handleUndo}
        onRedo={handleRedo}
        gpuStats={gpuStats}
      />

      {/* Notification Bar for Uninitialized Models */}
      <ModelBuildNotification
        useDirectML={useDirectML}
        availableModels={availableModels}
        uninitializedModels={uninitializedModels}
        filters={filters}
        onBuildModel={handleBuildModel}
      />

      {/* Main Content */}
      <div className="flex-1 p-4 overflow-hidden">
        {panelSizesLoaded && (
        <PanelGroup direction="vertical" className="h-full gap-4">
          <Panel>
            <PanelGroup direction="horizontal" onLayout={handlePanelResize} className="h-full gap-4">
              {/* Left Panel - Output Preview & Controls */}
              <Panel defaultSize={panelSizes.leftPanel} minSize={30}>
                <div className="flex flex-col gap-4 h-full min-h-0">
                  {/* Preview Area */}
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
                  />

                  <ProgressPanel
                    upscaleProgress={upscaleProgress}
                    showConsole={showConsole}
                    setShowConsole={setShowConsole}
                    consoleOutput={consoleOutput}
                    consoleEndRef={consoleEndRef}
                    privacyMode={privacyMode}
                  />
                </div>
              </Panel>

              {/* Resize Handle */}
              <PanelResizeHandle className="w-1 bg-gray-800 hover:bg-primary-purple transition-colors rounded-full" />

              {/* Right Panel - Input & Info */}
              <Panel defaultSize={panelSizes.rightPanel} minSize={25}>
                <div ref={rightPanelRef} className="flex flex-col gap-2 overflow-y-auto overflow-x-hidden h-full min-h-0 pr-2 scrollbar-thin scrollbar-thumb-gray-700 scrollbar-track-transparent">
                  {/* Video Input */}
                  <VideoInputPanel
                    videoInfo={videoInfo}
                    isDragging={isDragging}
                    isProcessing={isProcessing}
                    queueCount={queue.length}
                    showQueue={queueStore.showQueue}
                    indexingProgress={indexingProgress}
                    privacyMode={privacyMode}
                    onSelectVideo={handleSelectVideoWithQueue}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    onToggleQueue={handleToggleQueue}
                  />
                  
                  <ModelSelectionPanel
                    availableModels={availableModels}
                    isProcessing={isProcessing}
                    useDirectML={useDirectML}
                    colorimetrySettings={colorimetrySettings}
                    videoInfo={videoInfo}
                    filterTemplates={filterTemplates}
                    filters={filters}
                    segment={segment}
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
                    onSegmentChange={handleSegmentChange}
                    onPreviewSegment={handlePreviewSegment}
                    onSeekFrame={handleSeekFrame}
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

                  {/* Editing Queue Item Banner */}
                  {queueStore.editingQueueItemId && (() => {
                    const editingItem = queue.find(q => q.id === queueStore.editingQueueItemId);
                    return editingItem ? (
                      <div className="flex-shrink-0 bg-gradient-to-r from-blue-900/30 to-purple-900/30 border border-blue-500/50 rounded-xl p-3">
                        <div className="flex items-center justify-between">
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-blue-400 font-medium mb-1">Editing Queue Item</p>
                            <p className="text-sm truncate" title={privacyMode ? undefined : editingItem.videoName}>
                              <PrivacyText
                                enabled={privacyMode}
                                value={editingItem.videoName}
                                maskLength={12}
                              />
                            </p>
                          </div>
                          <button
                            onClick={() => {
                              queueStore.setEditingQueueItemId(null);
                              queueStore.setShowQueue(false);
                            }}
                            className="ml-2 px-3 py-1 text-xs bg-dark-surface hover:bg-dark-bg rounded-lg transition-colors"
                          >
                            Exit
                          </button>
                        </div>
                      </div>
                    ) : null;
                  })()}

                  {/* Action Buttons */}
                  <ActionButtons
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
                    useDirectML={useDirectML}
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
                  />
                </div>
              </Panel>
            </PanelGroup>
          </Panel>
          
          {/* Queue Panel - Collapsible at the bottom */}
          {queueStore.showQueue && (
            <>
              <PanelResizeHandle className="h-1 bg-gray-800 hover:bg-primary-purple transition-colors rounded-full" />
              <Panel defaultSize={20} minSize={15} maxSize={40}>
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
              </Panel>
            </>
          )}
        </PanelGroup>
        )}
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
        useDirectML={useDirectML}
        showAutoBuildModal={showAutoBuildModal}
        autoBuildModelName={autoBuildModelName}
        autoBuildModelType={autoBuildModelType}
        autoBuildIsStatic={autoBuildIsStatic}
        autoBuildStaticShape={autoBuildStaticShape}
        showSettings={showSettings}
        onCloseSettings={() => closeModalWithFocusRestore(() => setShowSettings(false))}
        numStreams={numStreams}
        onUpdateNumStreams={updateNumStreams}
        onToggleDirectML={handleToggleDirectML}
        videoCompareArgs={videoCompareArgs}
        onUpdateVideoCompareArgs={handleUpdateVideoCompareArgs}
        onResetVideoCompareArgs={handleResetVideoCompareArgs}
        defaultOutputFolder={defaultOutputFolder}
        onUpdateDefaultOutputFolder={handleUpdateDefaultOutputFolder}
        onResetDefaultOutputFolder={handleResetDefaultOutputFolder}
        descriptiveNamingEnabled={descriptiveNamingEnabled}
        onUpdateDescriptiveNamingEnabled={handleUpdateDescriptiveNamingEnabled}
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