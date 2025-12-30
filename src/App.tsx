// src/App.tsx - Refactored with extracted components and hooks

import { useState, useEffect, useRef, useCallback } from 'react';
import { Sparkles, XCircle, ChevronDown, ChevronUp, Terminal, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { ImportModelModal } from './components/ImportModelModal';
import { AboutModal } from './components/AboutModal';
import { SettingsModal } from './components/SettingsModal';
import { AutoBuildModal } from './components/AutoBuildModal';
import { PluginsModal } from './components/PluginsModal';
import { ModelManagerModal } from './components/ModelManagerModal';
import { UpdateNotificationModal } from './components/UpdateNotificationModal';
import { VsMlrtUpdateModal } from './components/VsMlrtUpdateModal';
import { QueuePanel } from './components/QueuePanel';
import type { UpdateInfo, SegmentSelection, VsMlrtVersionInfo } from './electron';
import { Header } from './components/Header';
import { ModelBuildNotification } from './components/ModelBuildNotification';
import { useModels } from './hooks/useModels';
import { useSettings } from './hooks/useSettings';
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
import { useQueueManagement } from './hooks/useQueueManagement';
import { useQueueState } from './hooks/useQueueState';
import { useQueueHandlers } from './hooks/useQueueHandlers';
import { useQueueProcessing } from './hooks/useQueueProcessing';
import { useQueueEditing } from './hooks/useQueueEditing';
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

  // Setup and initialization hooks
  const { consoleOutput, consoleEndRef, addConsoleLog } = useConsoleLog();
  const { isSetupComplete, isCheckingDeps, hasCudaSupport, setupProgress, isSettingUp, handleSetup } = useSetup(addConsoleLog);
  const { useDirectML, toggleDirectML, numStreams, updateNumStreams } = useSettings(hasCudaSupport);
  const { 
    ffmpegArgs, 
    processingFormat,
    outputFormat,
    videoCompareArgs,
    handleUpdateFfmpegArgs, 
    handleUpdateProcessingFormat,
    handleUpdateOutputFormat,
    handleUpdateVideoCompareArgs,
    handleResetVideoCompareArgs
  } = useProcessingConfig(isSetupComplete);
  
  // Model management hooks
  const {
    availableModels,
    selectedModel,
    setSelectedModel,
    filteredModels,
    loadModels,
    loadUninitializedModels,
    uninitializedModels,
  } = useModels(isSetupComplete, useDirectML);
  const { templates: filterTemplates, saveTemplate, deleteTemplate, loadTemplates } = useFilterTemplates(isSetupComplete);
  
  // State management hooks
  const { filters, handleSetFilters } = useFilterConfig(isSetupComplete, addConsoleLog);
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
  
  // Model manager modal state
  const [showModelManager, setShowModelManager] = useState(false);
  
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
    updatePreviewFrame,
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
    handleSelectVideoWithQueue,
    handleBatchFiles,
    handleAddCurrentVideoToQueue,
  } = useBatchConfig({
    outputFormat,
    selectedModel,
    filters,
    useDirectML,
    numStreams,
    segment,
    showQueue: queueState.showQueue,
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
    segment,
    isProcessingQueueItem: queueState.isProcessingQueueItem,
    setEditingQueueItemId: queueActions.setEditingQueueItemId,
    setIsQueueStarted: queueActions.setIsQueueStarted,
    setIsProcessingQueue: queueActions.setIsProcessingQueue,
    setIsProcessingQueueItem: queueActions.setIsProcessingQueueItem,
    setIsQueueStopping: queueActions.setIsQueueStopping,
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
    segment,
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
    handleCancelBuild,
    handleModelTypeChange,
    handleShapeModeChange,
    handleFp32Change,
    handlePrecisionChange,
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
    const newShowQueue = !queueState.showQueue;
    
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
    
    queueActions.setShowQueue(newShowQueue);
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
    onError: (message) => alert(`Workflow Validation Error:\n\n${message}`),
  });

  // Clear validation status when workflow or loaded video changes
  useEffect(() => {
    clearValidationStatus();
  }, [filters, selectedModel, useDirectML, numStreams, videoInfo?.path, clearValidationStatus]);

  // Reset segment selection when video changes (but not when loading a queue item)
  useEffect(() => {
    // Don't reset segment when we're editing a queue item - the segment will be restored from the queue item's workflow
    if (videoInfo && !queueState.editingQueueItemId) {
      setSegment({
        enabled: false,
        startFrame: 0,
        endFrame: -1,
      });
    }
  }, [videoInfo?.path, queueState.editingQueueItemId]);

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

  // Check for vs-mlrt version mismatch on startup
  useEffect(() => {
    const checkVsMlrtVersion = async (): Promise<void> => {
      try {
        const versionInfo = await window.electronAPI.checkVsMlrtVersion();
        
        if (versionInfo.needsNotification) {
          // Version changed and there are existing engines - show modal immediately
          addConsoleLog(`vs-mlrt version upgrade detected: ${versionInfo.storedVersion || 'unknown'} → ${versionInfo.currentVersion}`);
          setVsMlrtVersionInfo(versionInfo);
          setShowVsMlrtModal(true);
        } else if (versionInfo.storedVersion === undefined && versionInfo.engineCount > 0) {
          // Upgrading from old version that didn't track vs-mlrt version, but engines exist
          addConsoleLog(`vs-mlrt version upgrade detected (${versionInfo.engineCount} engine(s) from previous version may need rebuilding)`);
          setVsMlrtVersionInfo(versionInfo);
          setShowVsMlrtModal(true);
        } else if (versionInfo.hasVersionMismatch) {
          // CRITICAL: Version changed - ALWAYS show modal to let user decide when to update
          // This preserves user control and prevents unexpected plugin replacement
          addConsoleLog(`vs-mlrt version mismatch detected: ${versionInfo.storedVersion} → ${versionInfo.currentVersion}`);
          setVsMlrtVersionInfo(versionInfo);
          setShowVsMlrtModal(true);
        } else if (versionInfo.storedVersion === undefined) {
          // First run or version not tracked yet - store the current version
          await window.electronAPI.updateVsMlrtVersion();
          addConsoleLog(`vs-mlrt version initialized: ${versionInfo.currentVersion}`);
        } else {
          // Version matches - no action needed
          addConsoleLog(`vs-mlrt version: ${versionInfo.currentVersion}`);
        }
      } catch (error) {
        console.error('Failed to check vs-mlrt version:', error);
        addConsoleLog(`Error checking vs-mlrt version: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    };
    
    if (isSetupComplete && hasCudaSupport) {
      // Check immediately after setup completes to catch upgrades
      checkVsMlrtVersion();
    }
  }, [isSetupComplete, hasCudaSupport, addConsoleLog]);

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

  // Focus recovery mechanism for Electron/Chromium focus desync issues
  // Uses event-driven approach instead of polling to prevent GUI freezing
  useEffect(() => {
    let focusRecoveryPending = false;

    // Handle focus recovery after user interaction if focus is stuck
    const handleInteraction = (e: Event) => {
      // Avoid recursive focus handling
      if (focusRecoveryPending) return;
      
      const target = e.target as HTMLElement;
      
      // Don't interfere with inputs, textareas, selects - let browser handle focus naturally
      if (target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      )) {
        return;
      }
      
      // Use requestAnimationFrame to check focus after the event completes
      requestAnimationFrame(() => {
        const activeElement = document.activeElement;
        
        // Only recover focus if it's stuck on body/document and the click was on an interactive element
        if (!activeElement || activeElement === document.body || activeElement === document.documentElement) {
          // Check if the event target is or contains a focusable element
          if (target && target.closest) {
            const focusable = target.closest('button, a, [tabindex]:not([tabindex="-1"])');
            if (focusable instanceof HTMLElement) {
              focusRecoveryPending = true;
              focusable.focus({ preventScroll: true });
              focusRecoveryPending = false;
              return;
            }
          }
          
          // Only use window.focus() as a last resort, and never blur first
          // as that can cause the desync we're trying to fix
          window.focus();
        }
      });
    };

    // Handle window blur/focus events for app-level focus recovery
    const handleWindowBlur = () => {
      // Mark that we lost focus - used to detect stuck state
    };

    const handleWindowFocus = () => {
      // When window regains focus, ensure an element is focused
      requestAnimationFrame(() => {
        const activeElement = document.activeElement;
        if (!activeElement || activeElement === document.body || activeElement === document.documentElement) {
          const mainContent = document.querySelector('main') || document.querySelector('[role="main"]');
          if (mainContent instanceof HTMLElement) {
            mainContent.focus({ preventScroll: true });
          }
        }
      });
    };

    // Only listen for mousedown - less intrusive than polling
    document.addEventListener('mousedown', handleInteraction, { passive: true, capture: true });
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('focus', handleWindowFocus);

    return () => {
      document.removeEventListener('mousedown', handleInteraction, true);
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, []);

  const handleToggleDirectML = (value: boolean): void => {
    toggleDirectML(value);
    addConsoleLog(`Inference backend changed to: ${value ? 'DirectML (ONNX Runtime)' : 'TensorRT'}`);
  };

  // Helper to restore focus after modal closes (fixes Electron/Chromium focus desync)
  const closeModalWithFocusRestore = useCallback((closeFn: () => void) => {
    closeFn();
    // Delay focus restoration to allow React to unmount the modal
    requestAnimationFrame(() => {
      // Find a suitable element to focus, or just ensure window has focus
      const mainContent = document.querySelector('main') || document.body;
      if (mainContent instanceof HTMLElement) {
        mainContent.focus({ preventScroll: true });
      }
      window.focus();
    });
  }, []);

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
    
    // Basic validation
    if (!videoInfo || !outputPath) return true;
    
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
      />
    );
  }

  // Main App UI
  return (
    <div className="h-screen flex flex-col bg-gradient-to-br from-dark-bg via-dark-surface to-dark-bg overflow-hidden">
      {/* Header */}
      <Header
        isProcessing={isProcessing}
        useDirectML={useDirectML}
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
      />

      {/* Notification Bar for Uninitialized Models */}
      <ModelBuildNotification
        useDirectML={useDirectML}
        filteredModels={filteredModels}
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

                  {/* Console */}
                  <div className="flex-shrink-0 bg-dark-elevated rounded-2xl border border-gray-800 overflow-hidden">
                    <button
                      onClick={() => setShowConsole(!showConsole)}
                      className="w-full px-4 py-3 border-b border-gray-800 flex items-center justify-between hover:bg-dark-surface transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <Terminal className="w-5 h-5 text-accent-cyan" />
                        <h2 className="font-semibold">Console</h2>
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
                    showQueue={queueState.showQueue}
                    onSelectVideo={handleSelectVideoWithQueue}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    onToggleQueue={handleToggleQueue}
                  />
                  
                  <ModelSelectionPanel
                    filteredModels={filteredModels}
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
                    onManageModels={() => setShowModelManager(true)}
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
                    onFormatChange={handleUpdateOutputFormat}
                    onSelectOutputFile={handleSelectOutputFile}
                    onFfmpegArgsChange={handleUpdateFfmpegArgs}
                    onProcessingFormatChange={handleUpdateProcessingFormat}
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
                  <div className="flex-shrink-0 flex gap-2 relative">
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

                    {/* Validate Workflow Button - hidden during processing */}
                    {!isProcessing && (
                      <button
                        onClick={isValidating ? cancelValidation : validateWorkflow}
                        disabled={!videoInfo && !isValidating}
                        className={`font-semibold py-4 px-6 rounded-xl transition-all duration-300 flex items-center justify-center gap-2 ${
                          isValidating
                            ? 'bg-orange-600 hover:bg-orange-700 cursor-pointer text-white'
                            : validationStatus === 'success'
                            ? 'bg-green-600 hover:bg-green-700 text-white border border-green-500'
                            : validationStatus === 'error'
                            ? 'bg-red-600 hover:bg-red-700 text-white border border-red-500'
                            : 'bg-dark-surface hover:bg-dark-bg border border-gray-700 hover:border-primary-blue disabled:border-gray-800 disabled:text-gray-600 disabled:cursor-not-allowed'
                        }`}
                        title={isValidating ? 'Click to cancel validation' : validationStatus === 'error' && validationError ? `Error: ${validationError}` : 'Validate the current workflow by processing first 5 seconds'}
                      >
                        {isValidating ? (
                          <>
                            <XCircle className="w-5 h-5" />
                            Cancel
                          </>
                        ) : validationStatus === 'success' ? (
                          <>
                            <CheckCircle className="w-5 h-5" />
                            Valid
                          </>
                        ) : validationStatus === 'error' ? (
                          <>
                            <AlertCircle className="w-5 h-5" />
                            Failed
                          </>
                        ) : (
                          <>
                            <CheckCircle className="w-5 h-5" />
                            Validate
                          </>
                        )}
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
                        onClick={isProcessing ? handleCancelUpscale : () => handleUpscale(selectedModel || '', useDirectML, filters, numStreams, segment)}
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
            </PanelGroup>
          </Panel>
          
          {/* Queue Panel - Collapsible at the bottom */}
          {queueState.showQueue && (
            <>
              <PanelResizeHandle className="h-1 bg-gray-800 hover:bg-primary-purple transition-colors rounded-full" />
              <Panel defaultSize={20} minSize={15} maxSize={40}>
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
        onClose={() => closeModalWithFocusRestore(() => setShowImportModal(false))}
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
        importProgress={importProgress}
        mode={modalMode}
        useDirectML={useDirectML}
      />

      <AutoBuildModal
        show={showAutoBuildModal}
        modelName={autoBuildModelName}
        modelType={autoBuildModelType}
        progress={importProgress}
        isStatic={autoBuildIsStatic}
        staticShape={autoBuildStaticShape}
      />

      <SettingsModal
        show={showSettings}
        onClose={() => closeModalWithFocusRestore(() => setShowSettings(false))}
        useDirectML={useDirectML}
        onToggleDirectML={handleToggleDirectML}
        numStreams={numStreams}
        onUpdateNumStreams={updateNumStreams}
        videoCompareArgs={videoCompareArgs}
        onUpdateVideoCompareArgs={handleUpdateVideoCompareArgs}
        onResetVideoCompareArgs={handleResetVideoCompareArgs}
      />

      <AboutModal
        show={showAbout}
        onClose={() => closeModalWithFocusRestore(() => setShowAbout(false))}
      />

      <PluginsModal
        show={showPlugins}
        onClose={() => closeModalWithFocusRestore(() => setShowPlugins(false))}
        onInstallationComplete={loadTemplates}
      />

      <ModelManagerModal
        isOpen={showModelManager}
        models={availableModels}
        onClose={() => closeModalWithFocusRestore(() => setShowModelManager(false))}
        onModelUpdated={async () => {
          await loadModels();
          await loadUninitializedModels();
        }}
      />

      {showUpdateModal && (
        <UpdateNotificationModal
          updateInfo={updateInfo}
          onClose={() => closeModalWithFocusRestore(() => setShowUpdateModal(false))}
        />
      )}

      {showVsMlrtModal && vsMlrtVersionInfo && (
        <VsMlrtUpdateModal
          versionInfo={vsMlrtVersionInfo}
          onClose={() => closeModalWithFocusRestore(() => setShowVsMlrtModal(false))}
          onEnginesCleared={async () => {
            await loadModels();
            await loadUninitializedModels();
          }}
        />
      )}
    </div>
  );
}

export default App;