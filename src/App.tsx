// src/App.tsx - Refactored with extracted components and hooks

import { useState, useEffect, useRef } from 'react';
import { Sparkles, XCircle, ChevronDown, ChevronUp, Terminal, Loader2 } from 'lucide-react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { ImportModelModal } from './components/ImportModelModal';
import { AboutModal } from './components/AboutModal';
import { SettingsModal } from './components/SettingsModal';
import { AutoBuildModal } from './components/AutoBuildModal';
import { PluginsModal } from './components/PluginsModal';
import { ModelManagerModal } from './components/ModelManagerModal';
import { UpdateNotificationModal } from './components/UpdateNotificationModal';
import { QueuePanel } from './components/QueuePanel';
import { BatchConfigModal } from './components/BatchConfigModal';
import type { UpdateInfo } from './electron';
import { Header } from './components/Header';
import { ModelBuildNotification } from './components/ModelBuildNotification';
import { useModels } from './hooks/useModels';
import { useSettings } from './hooks/useSettings';
import { useDeveloperMode } from './hooks/useDeveloperMode';
import { useModelImport } from './hooks/useModelImport';
import { useVideoDragDrop } from './hooks/useVideoDragDrop';
import { useFilterTemplates } from './hooks/useFilterTemplates';
import { useWorkflow } from './hooks/useWorkflow';
import { useSetup } from './hooks/useSetup';
import { useVideoProcessing } from './hooks/useVideoProcessing';
import { usePanelLayout } from './hooks/usePanelLayout';
import { useOutputResolution } from './hooks/useOutputResolution';
import { useColorMatrix } from './hooks/useColorMatrix';
import { useFilterConfig } from './hooks/useFilterConfig';
import { useUIState } from './hooks/useUIState';
import { useBackendOperations } from './hooks/useBackendOperations';
import { useQueueManagement } from './hooks/useQueueManagement';
import { useQueueState } from './hooks/useQueueState';
import { useQueueHandlers } from './hooks/useQueueHandlers';
import { useQueueProcessing } from './hooks/useQueueProcessing';
import { useQueueEditing } from './hooks/useQueueEditing';
import { useBatchConfig } from './hooks/useBatchConfig';
import { getErrorMessage } from './types/errors';
import { SetupScreen } from './components/SetupScreen';
import { VideoPreviewPanel } from './components/VideoPreviewPanel';
import { VideoInputPanel } from './components/VideoInputPanel';
import { VideoInfoPanel } from './components/VideoPanel';
import { OutputSettingsPanel } from './components/OutputSettingsPanel';
import { ModelSelectionPanel } from './components/ModelSelectionPanel';
import { getPortableModelName } from './utils/modelUtils';

function App() {
  // Output format state
  const [outputFormat, setOutputFormat] = useState<string>('mkv');
  
  // FFmpeg configuration state (loaded from backend)
  const [ffmpegArgs, setFfmpegArgs] = useState<string>('');
  
  // Ref to preserve scroll position in right panel
  const rightPanelRef = useRef<HTMLDivElement>(null);

  // Setup and initialization hooks
  const { developerMode, isDeveloperModeLoaded, consoleOutput, consoleEndRef, addConsoleLog, toggleDeveloperMode } = useDeveloperMode();
  const { isSetupComplete, isCheckingDeps, hasCudaSupport, setupProgress, isSettingUp, handleSetup } = useSetup(addConsoleLog);
  const { useDirectML, toggleDirectML, numStreams, updateNumStreams } = useSettings(hasCudaSupport);
  
  // Model management hooks
  const {
    availableModels,
    selectedModel,
    setSelectedModel,
    filteredModels,
    loadModels,
    loadUninitializedModels,
    uninitializedModels,
  } = useModels(isSetupComplete, useDirectML, developerMode);
  const { templates: filterTemplates, saveTemplate, deleteTemplate, loadTemplates } = useFilterTemplates(isSetupComplete);
  
  // State management hooks
  const { filters, handleSetFilters } = useFilterConfig(isSetupComplete, developerMode, isDeveloperModeLoaded, addConsoleLog);
  const { colorMatrixSettings, handleColorMatrixChange } = useColorMatrix(isSetupComplete, addConsoleLog);
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
  
  // Model manager modal state
  const [showModelManager, setShowModelManager] = useState(false);
  
  // Update notification state
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);

  // Queue management state and handlers
  const { state: queueState, actions: queueActions } = useQueueState(addConsoleLog);

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
  } = useVideoProcessing({ outputFormat, onLog: addConsoleLog });
  
  // Queue management hook
  const {
    queue,
    isLoadingQueue: _isLoadingQueue,
    addToQueue,
    removeFromQueue,
    updateQueueItem,
    updateItemWorkflow,
    clearQueue,
    clearCompletedItems,
    reorderQueue,
    getNextPendingItem,
    getQueueStats: _getQueueStats,
    requeueItem,
  } = useQueueManagement({ onLog: addConsoleLog });

  // Batch configuration hook
  const {
    showBatchConfig,
    pendingBatchVideos,
    handleSelectVideoWithQueue,
    handleBatchFiles,
    handleConfirmBatchConfig,
    handleCloseBatchConfig,
  } = useBatchConfig({
    outputFormat,
    selectedModel,
    filters,
    useDirectML,
    numStreams,
    onAddToQueue: (videoPaths, workflow, outputPath) => {
      addToQueue(videoPaths, workflow, outputPath);
      queueActions.setShowQueue(true);
    },
    onLoadVideoInfo: loadVideoInfo,
    onLog: addConsoleLog,
  });

  // Queue handlers hook
  const {
    handleSelectQueueItem,
    handleStartQueue,
    handleStopQueue,
    handleCancelQueueItem,
    handleRequeueItem,
    handleCompareQueueItem,
    handleOpenQueueItemFolder,
  } = useQueueHandlers({
    queue,
    editingQueueItemId: queueState.editingQueueItemId,
    selectedModel,
    filters,
    outputFormat,
    useDirectML,
    numStreams,
    isProcessingQueueItem: queueState.isProcessingQueueItem,
    setEditingQueueItemId: queueActions.setEditingQueueItemId,
    setIsQueueStarted: queueActions.setIsQueueStarted,
    setIsProcessingQueue: queueActions.setIsProcessingQueue,
    setIsProcessingQueueItem: queueActions.setIsProcessingQueueItem,
    setIsQueueStopping: queueActions.setIsQueueStopping,
    setSelectedModel,
    setFilters: handleSetFilters,
    setOutputFormat,
    toggleDirectML,
    updateNumStreams,
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
    isQueueStarted: queueState.isQueueStarted,
    isQueueStopping: queueState.isQueueStopping,
    isProcessingQueueItem: queueState.isProcessingQueueItem,
    isProcessingQueue: queueState.isProcessingQueue,
    isProcessing,
    upscaleProgress,
    setIsProcessingQueue: queueActions.setIsProcessingQueue,
    setIsProcessingQueueItem: queueActions.setIsProcessingQueueItem,
    setIsQueueStarted: queueActions.setIsQueueStarted,
    setVideoInfo,
    setOutputPath,
    updateQueueItem,
    getNextPendingItem,
    onLog: addConsoleLog,
  });

  // Queue editing effects
  useQueueEditing({
    editingQueueItemId: queueState.editingQueueItemId,
    showQueue: queueState.showQueue,
    selectedModel,
    filters,
    outputFormat,
    useDirectML,
    numStreams,
    setEditingQueueItemId: queueActions.setEditingQueueItemId,
    updateItemWorkflow,
    onLog: addConsoleLog,
  });
  
  // Workflow management hook
  const {
    currentWorkflow,
    handleLoadWorkflow,
    handleClearWorkflow,
    handleExportWorkflow,
    handleImportWorkflow,
  } = useWorkflow({
    filters,
    selectedModel,
    setFilters: handleSetFilters,
    setSelectedModel,
    availableModels: availableModels.map(m => m.path),
    addConsoleLog,
    refreshFilterTemplates: loadTemplates,
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
    handleModelTypeChange,
    handleShapeModeChange,
    handleFp32Change,
    handleAutoBuildModel,
    showAutoBuildModal,
    autoBuildModelName,
    autoBuildModelType,
  } = useModelImport(useDirectML, async (enginePath?: string) => {
    await loadModels();
    await loadUninitializedModels();
    // Auto-select the imported/built model
    if (enginePath) {
      setSelectedModel(enginePath);
      addConsoleLog(`Auto-selected model: ${enginePath}`);
      
      // In advanced mode, also update AI Model filters to use the new engine
      if (developerMode && filters.length > 0) {
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
  const { handleReloadBackend, handleBuildModel, handleAutoBuild } = useBackendOperations({
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
  
  // Output resolution calculation hook
  useOutputResolution({
    videoInfo,
    selectedModel: selectedModel || '',
    useDirectML,
    filters,
    numStreams,
    onLog: addConsoleLog,
    onUpdateVideoInfo: setVideoInfo,
  });

  // Preserve scroll position in right panel when preview updates
  useEffect(() => {
    const rightPanel = rightPanelRef.current;
    if (rightPanel) {
      const scrollTop = rightPanel.scrollTop;
      // Restore scroll position after render
      requestAnimationFrame(() => {
        rightPanel.scrollTop = scrollTop;
      });
    }
  }, [previewFrame]);

  // Load FFmpeg configuration on mount
  useEffect(() => {
    const loadFfmpegConfig = async (): Promise<void> => {
      try {
        const argsResult = await window.electronAPI.getFfmpegArgs();
        setFfmpegArgs(argsResult.args);
      } catch (error) {
        console.error('Failed to load FFmpeg config:', error);
      }
    };
    
    if (isSetupComplete) {
      loadFfmpegConfig();
    }
  }, [isSetupComplete]);

  // Check for updates on startup
  useEffect(() => {
    const checkForUpdates = async (): Promise<void> => {
      try {
        const result = await window.electronAPI.checkForUpdates();
        if (result.success && result.data && result.data.available) {
          setUpdateInfo(result.data);
          setShowUpdateModal(true);
          addConsoleLog(`Update available: ${result.data.latestVersion}`);
        } else {
          addConsoleLog('No updates available');
        }
      } catch (error) {
        console.error('Failed to check for updates:', error);
      }
    };
    
    if (isSetupComplete) {
      // Check for updates after a short delay to avoid blocking initial load
      const timeoutId = setTimeout(checkForUpdates, 2000);
      return () => clearTimeout(timeoutId);
    }
  }, [isSetupComplete, addConsoleLog]);

  // Global error handlers with proper cleanup
  useEffect(() => {
    const handleError = (event: ErrorEvent): void => {
      event.preventDefault();
      const message = getErrorMessage(event.error || event.message);
      alert(`Error: ${message}`);
    };

    const handleRejection = (event: PromiseRejectionEvent): void => {
      event.preventDefault();
      const message = getErrorMessage(event.reason);
      alert(`Error: ${message}`);
    };

    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleRejection);

    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleRejection);
    };
  }, []);

  const handleToggleDirectML = (value: boolean): void => {
    toggleDirectML(value);
    addConsoleLog(`Inference backend changed to: ${value ? 'DirectML (ONNX Runtime)' : 'TensorRT'}`);
  };

  const handleToggleDeveloperMode = async (value: boolean): Promise<void> => {
    try {
      await toggleDeveloperMode(value);
      addConsoleLog(`Developer mode ${value ? 'enabled' : 'disabled'}`);
      
      // Clear any loaded workflow when switching to simple mode
      if (!value) {
        if (currentWorkflow) {
          await handleClearWorkflow();
          addConsoleLog('Workflow cleared when switching to simple mode');
        }
        
        // Disable all filters when switching to simple mode
        if (filters.length > 0) {
          const disabledFilters = filters.map(f => ({ ...f, enabled: false }));
          handleSetFilters(disabledFilters);
          addConsoleLog('All filters disabled - upscaling only');
        }
      }
    } catch (error) {
      addConsoleLog(`Error setting developer mode: ${getErrorMessage(error)}`);
    }
  };

  const handleUpdateFfmpegArgs = async (args: string): Promise<void> => {
    try {
      setFfmpegArgs(args);
      await window.electronAPI.setFfmpegArgs(args);
    } catch (error) {
      console.error('Error updating FFmpeg args:', error);
    }
  };

  const handleResetFfmpegArgs = async (): Promise<void> => {
    try {
      const result = await window.electronAPI.getDefaultFfmpegArgs();
      setFfmpegArgs(result.args);
      await window.electronAPI.setFfmpegArgs(result.args);
    } catch (error) {
      console.error('Error resetting FFmpeg args:', error);
    }
  };

  // Determine if processing should be disabled
  const isStartDisabled = (() => {
    // Disable if stopping
    if (isStopping) return true;
    
    // Basic validation
    if (!videoInfo || !outputPath) return true;
    
    // Prevent processing if using TensorRT mode with ONNX models
    if (!useDirectML) {
      // Check simple mode selected model (only applies in simple mode)
      if (!developerMode && selectedModel && selectedModel.toLowerCase().endsWith('.onnx')) {
        return true;
      }
      
      // Check advanced mode AI model filters
      if (developerMode) {
        const hasOnnxModel = filters.some(f => 
          f.enabled && 
          f.filterType === 'aiModel' && 
          f.modelPath && 
          f.modelPath.toLowerCase().endsWith('.onnx')
        );
        if (hasOnnxModel) return true;
      }
    }
    
    // In advanced mode, allow processing without AI model
    // as long as there's at least one enabled filter or no filters at all
    if (developerMode) {
      // Allow if there are no filters (pure processing)
      if (filters.length === 0) return false;
      
      // Allow if at least one filter is enabled (AI model or custom)
      const hasEnabledFilter = filters.some(f => f.enabled);
      return !hasEnabledFilter;
    }
    
    // In simple mode, require a selected model
    if (!selectedModel) return true;
    
    return false;
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
      />
    );
  }

  // Main App UI
  return (
    <div className="h-screen flex flex-col bg-gradient-to-br from-dark-bg via-dark-surface to-dark-bg overflow-hidden">
      {/* Header */}
      <Header
        isProcessing={isProcessing}
        developerMode={developerMode}
        onSettingsClick={() => setShowSettings(true)}
        onPluginsClick={() => setShowPlugins(true)}
        onReloadBackend={handleReloadBackend}
        onAboutClick={() => setShowAbout(true)}
        onToggleDeveloperMode={handleToggleDeveloperMode}
        onLoadWorkflow={handleLoadWorkflow}
        onImportWorkflow={handleImportWorkflow}
        onExportWorkflow={handleExportWorkflow}
        onClearWorkflow={handleClearWorkflow}
        workflowName={currentWorkflow}
        isReloading={isReloading}
      />

      {/* Notification Bar for Uninitialized Models */}
      <ModelBuildNotification
        useDirectML={useDirectML}
        selectedModel={selectedModel}
        filteredModels={filteredModels}
        uninitializedModels={uninitializedModels}
        advancedMode={developerMode}
        filters={filters}
        onBuildModel={handleBuildModel}
        onAutoBuild={handleAutoBuild}
      />

      {/* Main Content */}
      <div className="flex-1 p-4 overflow-hidden">
        {panelSizesLoaded && (
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
                onCompareVideos={handleCompareVideos}
                onOpenOutputFolder={handleOpenOutputFolder}
                onVideoError={handleVideoError}
              />

              {/* Progress & Controls */}
              <div className="flex-shrink-0 bg-dark-elevated rounded-2xl border border-gray-800 p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium">{upscaleProgress?.message || 'Start an upscale!'}</span>
                  <span className="text-sm text-gray-400">
                    {upscaleProgress?.percentage !== undefined ? `${upscaleProgress.percentage}%` : 'N/A'}
                  </span>
                </div>
                <div className="w-full bg-dark-surface rounded-full h-2 mb-3">
                  <div 
                    className="bg-gradient-to-r from-primary-blue to-primary-purple h-2 rounded-full transition-all duration-300"
                    style={{ width: `${upscaleProgress?.percentage ?? 0}%` }}
                  />
                </div>
                {upscaleProgress?.fps ? (
                  <p className="text-base text-gray-400 font-medium">Speed: {upscaleProgress.fps} FPS</p>
                ) : (
                  <p className="text-base text-gray-400 font-medium">Speed: N/A</p>
                )}
              </div>

              {/* Developer Console */}
              {developerMode && (
                <div className="flex-shrink-0 bg-dark-elevated rounded-2xl border border-gray-800 overflow-hidden">
                  <button
                    onClick={() => setShowConsole(!showConsole)}
                    className="w-full px-4 py-3 border-b border-gray-800 flex items-center justify-between hover:bg-dark-surface transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <Terminal className="w-5 h-5 text-accent-cyan" />
                      <h2 className="font-semibold">Developer Console</h2>
                    </div>
                    {showConsole ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                  </button>
                  {showConsole && (
                    <div className="p-4 max-h-64 overflow-y-auto font-mono text-sm bg-black/30">
                      {consoleOutput.map((log, i) => (
                        <div key={i} className="text-gray-300 mb-1">{log}</div>
                      ))}
                      <div ref={consoleEndRef} />
                    </div>
                  )}
                </div>
              )}
            </div>
          </Panel>

          {/* Resize Handle */}
          <PanelResizeHandle className="w-1 bg-gray-800 hover:bg-primary-purple transition-colors rounded-full" />

          {/* Right Panel - Input & Info */}
          <Panel defaultSize={panelSizes.rightPanel} minSize={25}>
            <div ref={rightPanelRef} className="flex flex-col gap-2 overflow-y-auto h-full min-h-0 pr-2 scrollbar-thin scrollbar-thumb-gray-700 scrollbar-track-transparent">
              {/* Video Input */}
              <VideoInputPanel
                videoInfo={videoInfo}
                isDragging={isDragging}
                isProcessing={isProcessing}
                queueCount={queue.length}
                showQueue={queueState.showQueue}
                onSelectVideo={handleSelectVideoWithQueue}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onToggleQueue={() => queueActions.setShowQueue(!queueState.showQueue)}
              />
              
              <ModelSelectionPanel
                selectedModel={selectedModel}
                filteredModels={filteredModels}
                isProcessing={isProcessing}
                advancedMode={developerMode}
                useDirectML={useDirectML}
                colorMatrixSettings={colorMatrixSettings}
                videoInfo={videoInfo}
                filterTemplates={filterTemplates}
                filters={filters}
                onModelChange={setSelectedModel}
                onImportClick={() => {
                  setModalMode('import');
                  setShowImportModal(true);
                }}
                onManageModels={() => setShowModelManager(true)}
                onColorMatrixChange={handleColorMatrixChange}
                onFiltersChange={handleSetFilters}
                onSaveTemplate={saveTemplate}
                onDeleteTemplate={deleteTemplate}
              />

              {/* Output Settings */}
              <OutputSettingsPanel
                videoInfo={videoInfo}
                outputPath={outputPath}
                outputFormat={outputFormat}
                isProcessing={isProcessing}
                onFormatChange={setOutputFormat}
                onSelectOutputFile={handleSelectOutputFile}
              />

              {/* Video Info */}
              <VideoInfoPanel
                videoInfo={videoInfo}
                showVideoInfo={showVideoInfo}
                onToggle={handleToggleVideoInfo}
              />

              {/* Editing Queue Item Banner */}
              {queueState.editingQueueItemId && (() => {
                const editingItem = queue.find(q => q.id === queueState.editingQueueItemId);
                return editingItem ? (
                  <div className="flex-shrink-0 bg-gradient-to-r from-blue-900/30 to-purple-900/30 border border-blue-500/50 rounded-xl p-3">
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-blue-400 font-medium mb-1">Editing Queue Item</p>
                        <p className="text-sm truncate" title={editingItem.videoName}>{editingItem.videoName}</p>
                      </div>
                      <button
                        onClick={() => {
                          queueActions.setEditingQueueItemId(null);
                          queueActions.setShowQueue(false);
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
              <div className="flex-shrink-0 flex gap-2">
                {/* Force Stop Button - Only visible when stuck */}
                {!isProcessing && upscaleProgress && upscaleProgress.type === 'progress' && (
                   <button
                     onClick={handleForceStop}
                     className="bg-red-900/50 hover:bg-red-800 text-red-200 px-4 rounded-xl border border-red-700/50 transition-colors flex items-center gap-2"
                     title="Force stop stuck process"
                   >
                     <XCircle className="w-5 h-5" />
                   </button>
                )}

                {queueState.showQueue ? (
                  <button
                    onClick={queueState.isQueueStarted ? handleStopQueue : handleStartQueue}
                    disabled={(!queueState.isQueueStarted && queue.filter(item => item.status === 'pending').length === 0) || queueState.isQueueStopping}
                    className={`flex-1 font-semibold py-4 px-6 rounded-xl transition-all duration-300 flex items-center justify-center gap-3 ${
                      queueState.isQueueStarted
                        ? queueState.isQueueStopping
                          ? 'bg-orange-600 cursor-wait'
                          : 'bg-orange-500 hover:bg-orange-600'
                        : 'bg-gradient-to-r from-primary-blue to-primary-purple hover:from-blue-600 hover:to-purple-600 disabled:from-gray-700 disabled:to-gray-700 disabled:cursor-not-allowed'
                    }`}
                  >
                    {queueState.isQueueStarted ? (
                      queueState.isQueueStopping ? (
                        <>
                          <Loader2 className="w-5 h-5 animate-spin" />
                          Stopping Queue...
                        </>
                      ) : (
                        <>
                          <XCircle className="w-5 h-5" />
                          Stop Queue
                        </>
                      )
                    ) : (
                      <>
                        <Sparkles className="w-5 h-5" />
                        Start Queue
                      </>
                    )}
                  </button>
                ) : (
                  <button
                    onClick={isProcessing ? handleCancelUpscale : () => handleUpscale(selectedModel || '', useDirectML, filters, numStreams)}
                    disabled={isStartDisabled}
                    className={`flex-1 font-semibold py-4 px-6 rounded-xl transition-all duration-300 flex items-center justify-center gap-3 ${
                      isStopping
                        ? 'bg-orange-500 cursor-not-allowed'
                        : isProcessing
                        ? 'bg-red-500 hover:bg-red-600'
                        : 'bg-gradient-to-r from-primary-blue to-primary-purple hover:from-blue-600 hover:to-purple-600 disabled:from-gray-700 disabled:to-gray-700 disabled:cursor-not-allowed'
                    }`}
                  >
                    {isStopping ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin" />
                        Stopping...
                      </>
                    ) : isProcessing ? (
                      <>
                        <XCircle className="w-5 h-5" />
                        Stop Processing
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-5 h-5" />
                        Start Processing
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          </Panel>
          
          {/* Queue Panel - Collapsible on the right */}
          {queueState.showQueue && (
            <>
              <PanelResizeHandle className="w-1 bg-gray-800 hover:bg-primary-purple transition-colors rounded-full" />
              <Panel defaultSize={25} minSize={10} maxSize={40}>
                <QueuePanel
                  queue={queue}
                  isQueueStarted={queueState.isQueueStarted}
                  editingItemId={queueState.editingQueueItemId}
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
                />
              </Panel>
            </>
          )}
        </PanelGroup>
        )}
      </div>

      {/* Modals using extracted components */}
      <ImportModelModal
        show={showImportModal}
        onClose={() => setShowImportModal(false)}
        isImporting={isImporting}
        importForm={importForm}
        setImportForm={setImportForm}
        handleSelectOnnxFile={handleSelectOnnxFile}
        handleImportModel={handleImportModel}
        handleModelTypeChange={handleModelTypeChange}
        handleShapeModeChange={handleShapeModeChange}
        handleFp32Change={handleFp32Change}
        importProgress={importProgress}
        mode={modalMode}
        useDirectML={useDirectML}
      />

      <AutoBuildModal
        show={showAutoBuildModal}
        modelName={autoBuildModelName}
        modelType={autoBuildModelType}
        progress={importProgress}
      />

      <SettingsModal
        show={showSettings}
        onClose={() => setShowSettings(false)}
        useDirectML={useDirectML}
        onToggleDirectML={handleToggleDirectML}
        numStreams={numStreams}
        onUpdateNumStreams={updateNumStreams}
        ffmpegArgs={ffmpegArgs}
        onUpdateFfmpegArgs={handleUpdateFfmpegArgs}
        onResetFfmpegArgs={handleResetFfmpegArgs}
      />

      <AboutModal
        show={showAbout}
        onClose={() => setShowAbout(false)}
      />

      <PluginsModal
        show={showPlugins}
        onClose={() => setShowPlugins(false)}
        onInstallationComplete={loadTemplates}
      />

      <ModelManagerModal
        isOpen={showModelManager}
        models={availableModels}
        onClose={() => setShowModelManager(false)}
        onModelUpdated={async () => {
          await loadModels();
          await loadUninitializedModels();
        }}
      />

      {showUpdateModal && (
        <UpdateNotificationModal
          updateInfo={updateInfo}
          onClose={() => setShowUpdateModal(false)}
        />
      )}
      
      {/* Batch Config Modal */}
      {showBatchConfig && (
        <BatchConfigModal
          videos={pendingBatchVideos}
          onConfirm={handleConfirmBatchConfig}
          onClose={handleCloseBatchConfig}
        />
      )}
    </div>
  );
}

export default App;