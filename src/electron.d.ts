// src/electron.d.ts
export interface ElectronAPI {
  // Dependency management
  checkDependencies: () => Promise<boolean>;
  setupDependencies: () => Promise<{ success: boolean; error?: string }>;
  onSetupProgress: (callback: (progress: SetupProgress) => void) => () => void;
  detectCudaSupport: () => Promise<boolean>;
  
  // Video operations
  selectVideoFile: () => Promise<string[] | null>;
  selectOnnxFile: () => Promise<string | null>;
  selectTemplateFile: () => Promise<string | null>;
  getVideoInfo: (filePath: string) => Promise<VideoInfo>;
  readVideoFile: (filePath: string) => Promise<ArrayBuffer>;
  getVideoThumbnail: (filePath: string) => Promise<string | null>;
  getOutputResolution: (
    videoPath: string,
    modelPath: string | null,
    useDirectML?: boolean,
    upscalingEnabled?: boolean,
    filters?: Filter[],
    upscalePosition?: number,
    numStreams?: number
  ) => Promise<{ 
    resolution: string | null; 
    fps: number | null;
    pixelFormat?: string | null;
    codec?: string;
    scanType?: string;
  }>;
  getFilePathFromFile: (file: File) => string;
  
  // Model operations
  getAvailableModels: () => Promise<ModelFile[]>;
  getUninitializedModels: () => Promise<UninitializedModel[]>;
  initializeModel: (params: InitializeModelParams) => Promise<InitializeModelResult>;
  onModelInitProgress: (callback: (progress: ModelInitProgress) => void) => () => void;
  importCustomModel: (params: ImportModelParams) => Promise<ImportModelResult>;
  onModelImportProgress: (callback: (progress: ModelImportProgress) => void) => () => void;
  getModelMetadata: (modelId: string) => Promise<ModelMetadata | null>;
  updateModelMetadata: (modelId: string, metadata: Partial<ModelMetadata>) => Promise<{ success: boolean; error?: string }>;
  deleteModel: (modelPath: string, modelId: string) => Promise<{ success: boolean; error?: string }>;
  cancelModelImport: () => Promise<{ success: boolean }>;
  validateOnnxModel: (onnxPath: string) => Promise<ValidateOnnxModelResult>;
  
  // Upscaling operations
  selectOutputFile: (defaultName: string) => Promise<string | null>;
  startUpscale: (
    videoPath: string, 
    modelPath: string | null, 
    outputPath: string, 
    useDirectML?: boolean, 
    upscalingEnabled?: boolean,
    filters?: Filter[],
    upscalePosition?: number,
    numStreams?: number,
    segment?: SegmentSelection
  ) => Promise<UpscaleResult>;
  previewSegment: (
    videoPath: string,
    modelPath: string | null,
    useDirectML?: boolean,
    upscalingEnabled?: boolean,
    filters?: Filter[],
    numStreams?: number,
    startFrame?: number,
    endFrame?: number
  ) => Promise<{ success: boolean; previewPath?: string; error?: string }>;
  cancelUpscale: () => Promise<{ success: boolean }>;
  killUpscale: () => Promise<{ success: boolean }>;
  onUpscaleProgress: (callback: (progress: UpscaleProgress) => void) => () => void;
  openOutputFolder: (filePath: string) => Promise<void>;
  compareVideos: (inputPath: string, outputPath: string) => Promise<{ success: boolean; error?: string }>;
  
  // Shell operations
  openExternal: (url: string) => Promise<void>;
  
  // App information
  getVersion: () => Promise<{ version: string }>;
  
  // Developer mode and folder access
  openLogsFolder: () => Promise<{ success: boolean }>;
  openConfigFolder: () => Promise<{ success: boolean }>;
  openVSPluginsFolder: () => Promise<{ success: boolean }>;
  openVSScriptsFolder: () => Promise<{ success: boolean }>;
  setDeveloperMode: (enabled: boolean) => Promise<{ success: boolean; enabled: boolean }>;
  getDeveloperMode: () => Promise<{ enabled: boolean }>;
  onDevConsoleLog: (callback: (log: DevConsoleLog) => void) => () => void;
  
  // Color matrix settings
  getColorMatrixSettings: () => Promise<ColorMatrixSettings>;
  setColorMatrixSettings: (settings: ColorMatrixSettings) => Promise<{ success: boolean }>;
  
  // FFmpeg configuration
  getFfmpegArgs: () => Promise<{ args: string }>;
  setFfmpegArgs: (args: string) => Promise<{ success: boolean }>;
  getDefaultFfmpegArgs: () => Promise<{ args: string }>;
  
  // Processing format
  getProcessingFormat: () => Promise<{ format: string }>;
  setProcessingFormat: (format: string) => Promise<{ success: boolean }>;

  // Video compare configuration
  getVideoCompareArgs: () => Promise<{ args: string }>;
  setVideoCompareArgs: (args: string) => Promise<{ success: boolean }>;
  getDefaultVideoCompareArgs: () => Promise<{ args: string }>;

  // Panel sizes
  getPanelSizes: () => Promise<{ leftPanel: number; rightPanel: number; queuePanel?: number }>;
  setPanelSizes: (sizes: { leftPanel: number; rightPanel: number; queuePanel?: number }) => Promise<{ success: boolean }>;
  
  // Queue UI state
  getShowQueue: () => Promise<{ show: boolean }>;
  setShowQueue: (show: boolean) => Promise<{ success: boolean }>;
  
  // Filter presets
  getFilterPresets: () => Promise<{ prefilterPreset: string; postfilterPreset: string }>;
  setFilterPresets: (presets: { prefilterPreset: string; postfilterPreset: string }) => Promise<{ success: boolean }>;
  getFilterConfigurations: () => Promise<Filter[]>;
  setFilterConfigurations: (filters: Filter[]) => Promise<{ success: boolean }>;
  
  // Backend operations
  reloadBackend: () => Promise<{ success: boolean; error?: string }>;
  
  // Filter template operations
  getFilterTemplates: () => Promise<FilterTemplate[]>;
  saveFilterTemplate: (template: FilterTemplate) => Promise<{ success: boolean; error?: string }>;
  deleteFilterTemplate: (name: string) => Promise<{ success: boolean; error?: string }>;
  readTemplateFile: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>;
  
  // File operations
  fileExists: (filePath: string) => Promise<boolean>;
  
  // Workflow operations
  exportWorkflow: (workflow: WorkflowData, filePath: string) => Promise<{ success: boolean; error?: string }>;
  importWorkflow: (filePath: string) => Promise<{ success: boolean; workflow?: WorkflowData; error?: string }>;
  selectWorkflowFile: (mode: 'open' | 'save') => Promise<string | null>;
  
  // Plugin dependency operations
  installPluginDependencies: () => Promise<{ success: boolean; error?: string }>;
  uninstallPluginDependencies: () => Promise<{ success: boolean; error?: string }>;
  checkPluginDependencies: () => Promise<{ installed: boolean; packages: string[] }>;
  cancelPluginDependencyInstall: () => Promise<{ success: boolean }>;
  onPluginDependencyProgress: (callback: (progress: PluginDependencyProgress) => void) => () => void;
  
  // Update operations
  checkForUpdates: () => Promise<{ success: boolean; data?: UpdateInfo; error?: string }>;
  openReleasesPage: () => Promise<{ success: boolean; error?: string }>;
  openReleaseUrl: (url: string) => Promise<{ success: boolean; error?: string }>;
  
  // Queue operations
  getQueue: () => Promise<QueueItem[]>;
  saveQueue: (queue: QueueItem[]) => Promise<{ success: boolean; error?: string }>;
  clearQueue: () => Promise<{ success: boolean; error?: string }>;
  
  // vs-mlrt version management
  checkVsMlrtVersion: () => Promise<VsMlrtVersionInfo>;
  clearEngineFiles: () => Promise<{ success: boolean; deletedCount: number; error?: string }>;
  updateVsMlrtVersion: () => Promise<{ success: boolean; version?: string; error?: string }>;
}

export interface DevConsoleLog {
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  timestamp: string;
}

export interface VsMlrtVersionInfo {
  storedVersion: string | undefined;
  currentVersion: string;
  hasVersionMismatch: boolean;
  engineCount: number;
  needsNotification: boolean;
}

export interface SetupProgress {
  type: 'download' | 'extract' | 'complete' | 'error' | 'model-extract';
  component: string;
  progress: number;
  message: string;
}

export interface VideoInfo {
  path: string;
  name: string;
  size: number;
  sizeFormatted: string;
  resolution?: string;
  outputResolution?: string;
  fps?: number;
  outputFps?: number;
  duration?: string;
  pixelFormat?: string;
  codec?: string;
  container?: string;
  scanType?: string;
  colorSpace?: string;
  outputPixelFormat?: string;
  outputCodec?: string;
  outputScanType?: string;
}

export interface ModelFile {
  id: string;
  name: string;
  path: string;
  precision: string;
  backend: 'tensorrt' | 'onnx';
  hasEngine?: boolean;
  modelType?: 'tspan' | 'image';
  displayTag?: string;
  description?: string;
}

export interface ModelMetadata {
  useFp32: boolean;
  useBf16?: boolean;
  modelType: 'tspan' | 'image';
  displayTag?: string;
  description?: string;
  createdAt?: string;
}

export interface UninitializedModel {
  id: string;
  name: string;
  onnxPath: string;
  modelType?: 'tspan' | 'image';
  displayTag?: string;
}

export interface InitializeModelParams {
  onnxPath: string;
  modelName: string;
  minShapes: string;
  optShapes: string;
  maxShapes: string;
  useFp32: boolean;
  useBf16?: boolean;
  modelType?: 'tspan' | 'image';
  displayTag?: string;
  useStaticShape?: boolean;
  useCustomTrtexecParams?: boolean;
  customTrtexecParams?: string;
}

export interface InitializeModelResult {
  success: boolean;
  enginePath?: string;
  error?: string;
}

export interface ValidateOnnxModelResult {
  isValid: boolean;
  error?: string;
  inputShape?: number[];
  outputShape?: number[];
  inputName?: string;
  isStatic?: boolean;
}

export interface ModelInitProgress {
  type: 'converting' | 'complete' | 'error';
  progress: number;
  message: string;
  enginePath?: string;
}

export interface ImportModelParams {
  onnxPath: string;
  modelName: string;
  minShapes: string;
  optShapes: string;
  maxShapes: string;
  useFp32: boolean;
  useBf16?: boolean;
  modelType?: 'tspan' | 'image';
  useDirectML?: boolean;
  displayTag?: string;
  useStaticShape?: boolean;
  useCustomTrtexecParams?: boolean;
  customTrtexecParams?: string;
}

export interface ImportModelResult {
  success: boolean;
  enginePath?: string;
  error?: string;
}

export interface ModelImportProgress {
  type: 'validating' | 'copying' | 'converting' | 'complete' | 'error';
  progress: number;
  message: string;
  enginePath?: string;
  detectedShape?: string;
  detectedStatic?: boolean;
}

export interface UpscaleProgress {
  type: 'progress' | 'complete' | 'error' | 'preview-frame';
  currentFrame: number;
  totalFrames: number;
  fps: number;
  percentage: number;
  message: string;
  previewFrame?: string;
  isStopping?: boolean;
}

export interface UpscaleResult {
  success: boolean;
  outputPath?: string;
  error?: string;
}

export interface Filter {
  id: string;
  enabled: boolean;
  filterType: 'aiModel' | 'custom';
  preset: string;
  code: string;
  order: number;
  modelPath?: string;
  modelType?: 'tspan' | 'image';
}

export interface SegmentSelection {
  enabled: boolean;
  startFrame: number;
  endFrame: number; // -1 means end of video
}

export interface ColorMatrixSettings {
  overwriteMatrix: boolean;
  matrix709: boolean;
  defaultMatrix: '709' | '170m';
  defaultPrimaries: '709' | '601';
  defaultTransfer: '709' | '170m';
}

export interface FilterTemplate {
  name: string;
  code: string;
  description?: string;
  metadata?: {
    author?: string;
    createdAt?: string;
    tags?: string[];
    [key: string]: any;
  };
}

export interface WorkflowData {
  name: string;
  version: string;
  filters: {
    name: string;
    code: string;
    description?: string;
    enabled: boolean;
    order: number;
    filterType: 'aiModel' | 'custom';
    modelPath?: string;
    modelType?: 'tspan' | 'image';
  }[];
  createdAt?: string;
  description?: string;
}

export interface PluginDependencyProgress {
  type: 'download' | 'extract' | 'install' | 'complete' | 'error';
  progress: number;
  message: string;
  package?: string;
}

export interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  changelog: string;
  publishedAt: string;
}

export interface QueueItem {
  id: string;
  videoPath: string;
  videoName: string;
  outputPath: string;
  status: 'pending' | 'processing' | 'completed' | 'error';
  progress?: number;
  errorMessage?: string;
  addedAt: string;
  completedAt?: string;
  // Workflow snapshot for this video
  workflow: {
    selectedModel: string | null;
    filters: Filter[];
    outputFormat: string;
    useDirectML: boolean;
    numStreams: number;
    segment?: SegmentSelection;
  };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}