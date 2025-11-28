// electron/preload.ts
import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Dependency management
  checkDependencies: () => ipcRenderer.invoke('check-dependencies'),
  detectCudaSupport: () => ipcRenderer.invoke('detect-cuda-support'),
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
  readVideoFile: (filePath: string) => ipcRenderer.invoke('read-video-file', filePath),
  getVideoThumbnail: (filePath: string) => ipcRenderer.invoke('get-video-thumbnail', filePath),
  getOutputResolution: (videoPath: string, modelPath: string | null, useDirectML?: boolean, upscalingEnabled?: boolean, filters?: any, upscalePosition?: number, numStreams?: number) =>
    ipcRenderer.invoke('get-output-resolution', videoPath, modelPath, useDirectML, upscalingEnabled, filters, upscalePosition, numStreams),
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
  
  // Upscaling operations
  selectOutputFile: (defaultName: string) => ipcRenderer.invoke('select-output-file', defaultName),
  startUpscale: (videoPath: string, modelPath: string, outputPath: string, useDirectML?: boolean, upscalingEnabled?: boolean, filters?: any, upscalePosition?: number, numStreams?: number, segment?: any) => 
    ipcRenderer.invoke('start-upscale', videoPath, modelPath, outputPath, useDirectML, upscalingEnabled, filters, upscalePosition, numStreams, segment),
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
  
  // Shell operations
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  
  // App information
  getVersion: () => ipcRenderer.invoke('get-version'),
  
  // Developer mode and folder access
  openLogsFolder: () => ipcRenderer.invoke('open-logs-folder'),
  openConfigFolder: () => ipcRenderer.invoke('open-config-folder'),
  openVSPluginsFolder: () => ipcRenderer.invoke('open-vs-plugins-folder'),
  openVSScriptsFolder: () => ipcRenderer.invoke('open-vs-scripts-folder'),
  setDeveloperMode: (enabled: boolean) => ipcRenderer.invoke('set-developer-mode', enabled),
  getDeveloperMode: () => ipcRenderer.invoke('get-developer-mode'),
  onDevConsoleLog: (callback: (log: any) => void) => {
    const listener = (event: any, log: any) => callback(log);
    ipcRenderer.on('dev-console-log', listener);
    return () => ipcRenderer.removeListener('dev-console-log', listener);
  },
  
  // Color matrix settings
  getColorMatrixSettings: () => ipcRenderer.invoke('get-color-matrix-settings'),
  setColorMatrixSettings: (settings: any) => ipcRenderer.invoke('set-color-matrix-settings', settings),
  
  // FFmpeg configuration
  getFfmpegArgs: () => ipcRenderer.invoke('get-ffmpeg-args'),
  setFfmpegArgs: (args: string) => ipcRenderer.invoke('set-ffmpeg-args', args),
  getDefaultFfmpegArgs: () => ipcRenderer.invoke('get-default-ffmpeg-args'),
  
  // Processing format
  getProcessingFormat: () => ipcRenderer.invoke('get-processing-format'),
  setProcessingFormat: (format: string) => ipcRenderer.invoke('set-processing-format', format),

  // Panel sizes
  getPanelSizes: () => ipcRenderer.invoke('get-panel-sizes'),
  setPanelSizes: (sizes: any) => ipcRenderer.invoke('set-panel-sizes', sizes),
  
  // Queue UI state
  getShowQueue: () => ipcRenderer.invoke('get-show-queue'),
  setShowQueue: (show: boolean) => ipcRenderer.invoke('set-show-queue', show),
  
  // Filter presets
  getFilterPresets: () => ipcRenderer.invoke('get-filter-presets'),
  setFilterPresets: (presets: any) => ipcRenderer.invoke('set-filter-presets', presets),
  
  // Backend operations
  reloadBackend: () => ipcRenderer.invoke('reload-backend'),
  
  // Filter template operations
  getFilterTemplates: () => ipcRenderer.invoke('get-filter-templates'),
  saveFilterTemplate: (template: any) => ipcRenderer.invoke('save-filter-template', template),
  deleteFilterTemplate: (name: string) => ipcRenderer.invoke('delete-filter-template', name),
  readTemplateFile: (filePath: string) => ipcRenderer.invoke('read-template-file', filePath),
  
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
});