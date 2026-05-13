// electron/preload.ts
import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Dependency management
  checkDependencies: () => ipcRenderer.invoke('check-dependencies'),
  detectCudaSupport: () => ipcRenderer.invoke('detect-cuda-support'),
  getGpuStats: () => ipcRenderer.invoke('get-gpu-stats'),
  setupDependencies: () => ipcRenderer.invoke('setup-dependencies'),
  onSetupProgress: (callback: (progress: any) => void) => {
    const listener = (event: any, progress: any) => callback(progress);
    ipcRenderer.on('setup-progress', listener);
    return () => ipcRenderer.removeListener('setup-progress', listener);
  },

  // Video operations
  selectVideoFile: () => ipcRenderer.invoke('select-video-file'),
  selectOnnxFile: () => ipcRenderer.invoke('select-onnx-file'),
  selectTemplateFile: () => ipcRenderer.invoke('select-template-file'),
  getVideoInfo: (filePath: string) => ipcRenderer.invoke('get-video-info', filePath),
  onVideoIndexProgress: (callback: (progress: { percentage: number; complete: boolean }) => void) => {
    const listener = (event: any, progress: { percentage: number; complete: boolean }) => callback(progress);
    ipcRenderer.on('video-index-progress', listener);
    return () => ipcRenderer.removeListener('video-index-progress', listener);
  },
  readVideoFile: (filePath: string) => ipcRenderer.invoke('read-video-file', filePath),
  getVideoThumbnail: (filePath: string) => ipcRenderer.invoke('get-video-thumbnail', filePath),
  getVideoFrameAt: (filePath: string, frameNumber: number, fps: number) => ipcRenderer.invoke('get-video-frame-at', filePath, frameNumber, fps),
  getOutputResolution: (videoPath: string, modelPath: string | null, useDirectML?: boolean, upscalingEnabled?: boolean, filters?: any, upscalePosition?: number, numStreams?: number, sourceFps?: number) =>
    ipcRenderer.invoke('get-output-resolution', videoPath, modelPath, useDirectML, upscalingEnabled, filters, upscalePosition, numStreams, sourceFps),
  cancelValidation: () => ipcRenderer.invoke('cancel-validation'),
  getFilePathFromFile: (file: File) => webUtils.getPathForFile(file),
  
  // Model operations
  getAvailableModels: () => ipcRenderer.invoke('get-available-models'),
  getUninitializedModels: () => ipcRenderer.invoke('get-uninitialized-models'),
  initializeModel: (params: any) => ipcRenderer.invoke('initialize-model', params),
  onModelInitProgress: (callback: (progress: any) => void) => {
    const listener = (event: any, progress: any) => callback(progress);
    ipcRenderer.on('model-init-progress', listener);
    return () => ipcRenderer.removeListener('model-init-progress', listener);
  },
  importCustomModel: (params: any) => ipcRenderer.invoke('import-custom-model', params),
  onModelImportProgress: (callback: (progress: any) => void) => {
    const listener = (event: any, progress: any) => callback(progress);
    ipcRenderer.on('model-import-progress', listener);
    return () => ipcRenderer.removeListener('model-import-progress', listener);
  },
  getModelMetadata: (modelId: string) => ipcRenderer.invoke('get-model-metadata', modelId),
  updateModelMetadata: (modelId: string, metadata: any) => ipcRenderer.invoke('update-model-metadata', modelId, metadata),
  deleteModel: (modelPath: string, modelId: string) => ipcRenderer.invoke('delete-model', modelPath, modelId),
  renameModel: (modelPath: string, modelId: string, newName: string) => ipcRenderer.invoke('rename-model', modelPath, modelId, newName),
  cancelModelImport: () => ipcRenderer.invoke('cancel-model-import'),
  forceStopModelImport: () => ipcRenderer.invoke('force-stop-model-import'),
  validateOnnxModel: (onnxPath: string) => ipcRenderer.invoke('validate-onnx-model', onnxPath),
  
  // Model category operations
  getModelCategories: () => ipcRenderer.invoke('get-model-categories'),
  updateModelCategory: (modelId: string, category: string | string[] | undefined) => ipcRenderer.invoke('update-model-category', modelId, category),
  
  // Upscaling operations
  selectOutputFile: (defaultName: string) => ipcRenderer.invoke('select-output-file', defaultName),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  startUpscale: (videoPath: string, modelPath: string, outputPath: string, useDirectML?: boolean, upscalingEnabled?: boolean, filters?: any, upscalePosition?: number, numStreams?: number, segment?: any, benchmarkMode?: boolean) =>
    ipcRenderer.invoke('start-upscale', videoPath, modelPath, outputPath, useDirectML, upscalingEnabled, filters, upscalePosition, numStreams, segment, benchmarkMode),
  previewSegment: (videoPath: string, modelPath: string | null, useDirectML?: boolean, upscalingEnabled?: boolean, filters?: any, numStreams?: number, startFrame?: number, endFrame?: number) =>
    ipcRenderer.invoke('preview-segment', videoPath, modelPath, useDirectML, upscalingEnabled, filters, numStreams, startFrame, endFrame),
  cancelUpscale: () => ipcRenderer.invoke('cancel-upscale'),
  killUpscale: () => ipcRenderer.invoke('kill-upscale'),
  onUpscaleProgress: (callback: (progress: any) => void) => {
    const listener = (event: any, progress: any) => callback(progress);
    ipcRenderer.on('upscale-progress', listener);
    return () => ipcRenderer.removeListener('upscale-progress', listener);
  },
  openOutputFolder: (filePath: string) => ipcRenderer.invoke('open-output-folder', filePath),
  compareVideos: (inputPath: string, outputPath: string) => ipcRenderer.invoke('compare-videos', inputPath, outputPath),
  launchVsePreviewer: (
    videoPath: string,
    modelPath: string | null,
    useDirectML?: boolean,
    upscalingEnabled?: boolean,
    filters?: any[],
    numStreams?: number,
    segment?: { enabled: boolean; startFrame: number; endFrame: number }
  ) => ipcRenderer.invoke('launch-vse-previewer', videoPath, modelPath, useDirectML, upscalingEnabled, filters, numStreams, segment),
  
  // Shell operations
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  
  // App information
  getVersion: () => ipcRenderer.invoke('get-version'),
  
  // Log file reading (efficient polling-based console)
  readLogTail: (maxLines?: number) => ipcRenderer.invoke('read-log-tail', maxLines),
  resetLogCache: () => ipcRenderer.invoke('reset-log-cache'),
  
  // Folder access
  openLogsFolder: () => ipcRenderer.invoke('open-logs-folder'),
  openConfigFolder: () => ipcRenderer.invoke('open-config-folder'),
  openVSPluginsFolder: () => ipcRenderer.invoke('open-vs-plugins-folder'),
  openVSScriptsFolder: () => ipcRenderer.invoke('open-vs-scripts-folder'),

  // Console logs
  onDevConsoleLog: (callback: (log: any) => void) => {
    const listener = (event: any, log: any) => callback(log);
    ipcRenderer.on('dev-console-log', listener);
    return () => ipcRenderer.removeListener('dev-console-log', listener);
  },
  
  // Colorimetry settings
  getColorimetrySettings: () => ipcRenderer.invoke('get-colorimetry-settings'),
  setColorimetrySettings: (settings: any) => ipcRenderer.invoke('set-colorimetry-settings', settings),
  
  // FFmpeg configuration
  getFfmpegArgs: () => ipcRenderer.invoke('get-ffmpeg-args'),
  setFfmpegArgs: (args: string) => ipcRenderer.invoke('set-ffmpeg-args', args),
  getDefaultFfmpegArgs: () => ipcRenderer.invoke('get-default-ffmpeg-args'),
  getVideoFilter: () => ipcRenderer.invoke('get-video-filter'),
  setVideoFilter: (filter: string) => ipcRenderer.invoke('set-video-filter', filter),
  
  // Output format
  getOutputFormat: () => ipcRenderer.invoke('get-output-format'),
  setOutputFormat: (format: string) => ipcRenderer.invoke('set-output-format', format),
  
  // Processing format
  getProcessingFormat: () => ipcRenderer.invoke('get-processing-format'),
  setProcessingFormat: (format: string) => ipcRenderer.invoke('set-processing-format', format),

  // Video compare configuration
  getVideoCompareArgs: () => ipcRenderer.invoke('get-video-compare-args'),
  setVideoCompareArgs: (args: string) => ipcRenderer.invoke('set-video-compare-args', args),
  getDefaultVideoCompareArgs: () => ipcRenderer.invoke('get-default-video-compare-args'),

  // Default output folder
  getDefaultOutputFolder: () => ipcRenderer.invoke('get-default-output-folder'),
  setDefaultOutputFolder: (folder: string | null) => ipcRenderer.invoke('set-default-output-folder', folder),

  // Descriptive naming
  getDescriptiveNamingEnabled: () => ipcRenderer.invoke('get-descriptive-naming-enabled'),
  setDescriptiveNamingEnabled: (enabled: boolean) => ipcRenderer.invoke('set-descriptive-naming-enabled', enabled),

  // Encoding settings panel state
  getEncodingSettingsExpanded: () => ipcRenderer.invoke('get-encoding-settings-expanded'),
  setEncodingSettingsExpanded: (expanded: boolean) => ipcRenderer.invoke('set-encoding-settings-expanded', expanded),

  // Panel sizes
  getPanelSizes: () => ipcRenderer.invoke('get-panel-sizes'),
  setPanelSizes: (sizes: any) => ipcRenderer.invoke('set-panel-sizes', sizes),
  
  // Queue UI state
  getShowQueue: () => ipcRenderer.invoke('get-show-queue'),
  setShowQueue: (show: boolean) => ipcRenderer.invoke('set-show-queue', show),
  
  // Backend operations
  reloadBackend: () => ipcRenderer.invoke('reload-backend'),
  
  // Filter template operations
  getFilterTemplates: () => ipcRenderer.invoke('get-filter-templates'),
  saveFilterTemplate: (template: any) => ipcRenderer.invoke('save-filter-template', template),
  deleteFilterTemplate: (name: string) => ipcRenderer.invoke('delete-filter-template', name),
  readTemplateFile: (filePath: string) => ipcRenderer.invoke('read-template-file', filePath),
  importTemplateFile: (filePath: string) => ipcRenderer.invoke('import-template-file', filePath),
  
  // File operations
  fileExists: (filePath: string) => ipcRenderer.invoke('file-exists', filePath),
  
  // Workflow operations
  selectWorkflowFile: (mode: 'open' | 'save') => ipcRenderer.invoke('select-workflow-file', mode),
  exportWorkflow: (workflow: any, filePath: string) => ipcRenderer.invoke('export-workflow', workflow, filePath),
  importWorkflow: (filePath: string) => ipcRenderer.invoke('import-workflow', filePath),
  
  // Filter configurations
  getFilterConfigurations: () => ipcRenderer.invoke('get-filter-configurations'),
  setFilterConfigurations: (filters: any) => ipcRenderer.invoke('set-filter-configurations', filters),
  
  // Plugin dependency operations
  installPluginDependencies: () => ipcRenderer.invoke('install-plugin-dependencies'),
  retrySetupPlugins: () => ipcRenderer.invoke('retry-setup-plugins'),
  uninstallPluginDependencies: () => ipcRenderer.invoke('uninstall-plugin-dependencies'),
  checkPluginDependencies: () => ipcRenderer.invoke('check-plugin-dependencies'),
  cancelPluginDependencyInstall: () => ipcRenderer.invoke('cancel-plugin-dependency-install'),
  onPluginDependencyProgress: (callback: (progress: any) => void) => {
    const listener = (event: any, progress: any) => callback(progress);
    ipcRenderer.on('plugin-dependency-progress', listener);
    return () => ipcRenderer.removeListener('plugin-dependency-progress', listener);
  },
  
  // Update operations
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  openReleasesPage: () => ipcRenderer.invoke('open-releases-page'),
  openReleaseUrl: (url: string) => ipcRenderer.invoke('open-release-url', url),
  
  // Queue operations
  getQueue: () => ipcRenderer.invoke('get-queue'),
  saveQueue: (queue: any[]) => ipcRenderer.invoke('save-queue', queue),
  clearQueue: () => ipcRenderer.invoke('clear-queue'),
  
  // vs-mlrt version management
  checkVsMlrtVersion: () => ipcRenderer.invoke('check-vsmlrt-version'),
  clearEngineFiles: () => ipcRenderer.invoke('clear-engine-files'),
  updateVsMlrtVersion: () => ipcRenderer.invoke('update-vsmlrt-version'),
  updateVsMlrtPlugin: () => ipcRenderer.invoke('update-vsmlrt-plugin'),
  onVsMlrtUpdateProgress: (callback: (progress: any) => void) => {
    const listener = (event: any, progress: any) => callback(progress);
    ipcRenderer.on('vsmlrt-update-progress', listener);
    return () => ipcRenderer.removeListener('vsmlrt-update-progress', listener);
  },
});