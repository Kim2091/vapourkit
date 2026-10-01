// src/electron.d.ts
import type { BackendId, FilterBackend } from '../electron/providers/descriptors';

export type { BackendId, FilterBackend };

export type RocmMode = 'auto' | 'environment' | 'custom';

export interface RocmSetting {
  mode: RocmMode;
  customRoot?: string;
}

export interface RocmStatus {
  supported: boolean;
  root: string | null;
  migraphxVersion: string | null;
  hasMigraphxLibrary: boolean;
  hasMigraphxDriver: boolean;
  summary: string;
}

export interface RocmSettingResult {
  setting: RocmSetting;
  status: RocmStatus;
}

export interface ElectronAPI {
  // Dependency management
  platform: NodeJS.Platform;
  checkDependencies: () => Promise<boolean>;
  /** Why NVENC encoding cannot work on this NVIDIA driver, or null */
  getNvencDriverProblem: () => Promise<string | null>;
  setupDependencies: () => Promise<InstallResult & { phase?: 'core' | 'plugins' }>;
  onSetupProgress: (callback: (progress: SetupProgress) => void) => () => void;
  detectCudaSupport: () => Promise<boolean>;
  getInferenceBackendInfo: () => Promise<{ hasCudaSupport: boolean; backend: BackendId }>;
  getGpuStats: () => Promise<{ gpuMemoryUsed: number; gpuMemoryTotal: number; gpuUtilization: number } | null>;
  
  // Video operations
  selectVideoFile: () => Promise<string[] | null>;
  /** One video file, for a step that matches against footage outside the chain. */
  selectReferenceVideo: () => Promise<string | null>;
  selectOnnxFile: () => Promise<string | null>;
  selectTemplateFile: () => Promise<string | null>;
  getVideoInfo: (filePath: string) => Promise<VideoInfo>;
  onVideoIndexProgress: (callback: (progress: { percentage: number; complete: boolean }) => void) => () => void;
  readVideoFile: (filePath: string) => Promise<ArrayBuffer>;
  getVideoThumbnail: (filePath: string) => Promise<string | null>;
  getVideoFrameAt: (filePath: string, frameNumber: number, fps: number) => Promise<string | null>;

  /**
   * One step of the filter chain, as the preview session reports it. The index
   * is the script's output index: 0 is the untouched source, and each enabled
   * filter adds one. Labels come from the app's own filter list, not from here.
   */
  previewOpen: (
    videoPath: string,
    modelPath: string | null,
    defaultBackend?: BackendId,
    upscalingEnabled?: boolean,
    filters?: Filter[],
    numStreams?: number,
    segment?: SegmentSelection
  ) => Promise<{
    success: boolean;
    error?: string;
    cancelled?: boolean;
    outputs?: PreviewOutput[];
    /** Names the playback port this open handed over. */
    token?: string;
  }>;
  previewSelect: (index: number) => Promise<{ success: boolean; error?: string }>;
  previewFrame: (n: number, width: number) => Promise<PreviewFrameResult>;
  /** Stops an open in flight, including a preflight sitting in an engine build. */
  previewCancel: () => Promise<{ success: boolean; cancelled: boolean }>;
  previewClose: () => Promise<{ success: boolean }>;
  /** Starts pushing frames down the playback port. */
  previewPlay: (options: PreviewPlayOptions) => Promise<{
    success: boolean;
    error?: string;
    stream?: number;
    prefetch?: number;
    from?: number;
  }>;
  previewStop: (stream: number) => Promise<{ success: boolean; error?: string; n?: number | null }>;
  getOutputResolution: (
    videoPath: string,
    modelPath: string | null,
    defaultBackend?: BackendId,
    upscalingEnabled?: boolean,
    filters?: Filter[],
    upscalePosition?: number,
    numStreams?: number,
    sourceFps?: number
  ) => Promise<{ 
    resolution: string | null; 
    fps: number | null;
    pixelFormat?: string | null;
    codec?: string;
    scanType?: string;
    error?: string;
  }>;
  cancelValidation: () => Promise<{ success: boolean; cancelled?: boolean }>;
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
  renameModel: (modelPath: string, modelId: string, newName: string) => Promise<{ success: boolean; newPath?: string; newId?: string; error?: string }>;
  cancelModelImport: () => Promise<{ success: boolean }>;
  forceStopModelImport: () => Promise<{ success: boolean }>;
  validateOnnxModel: (onnxPath: string) => Promise<ValidateOnnxModelResult>;
  
  // Upscaling operations
  selectOutputFile: (defaultName: string) => Promise<string | null>;
  selectFolder: () => Promise<string | null>;
  startUpscale: (
    videoPath: string,
    modelPath: string | null,
    outputPath: string,
    defaultBackend?: BackendId,
    upscalingEnabled?: boolean,
    filters?: Filter[],
    upscalePosition?: number,
    numStreams?: number,
    segment?: SegmentSelection,
    benchmarkMode?: boolean
  ) => Promise<UpscaleResult>;
  cancelUpscale: () => Promise<{ success: boolean }>;
  killUpscale: () => Promise<{ success: boolean }>;
  onUpscaleProgress: (callback: (progress: UpscaleProgress) => void) => () => void;
  onEngineBuildProgress: (callback: (status: EngineBuildStatus) => void) => () => void;
  openOutputFolder: (filePath: string) => Promise<void>;
  compareVideos: (inputPath: string, outputPath: string) => Promise<{ success: boolean; error?: string }>;
  launchVsePreviewer: (
    videoPath: string,
    modelPath: string | null,
    defaultBackend?: BackendId,
    upscalingEnabled?: boolean,
    filters?: Filter[],
    numStreams?: number,
    segment?: SegmentSelection
  ) => Promise<{ success: boolean; error?: string }>;
  
  // Shell operations
  openExternal: (url: string) => Promise<void>;
  
  // App information
  getVersion: () => Promise<{ version: string }>;
  
  // Log file reading (efficient polling-based console)
  readLogTail: (maxLines?: number) => Promise<{ lines: string[]; hasNewContent: boolean; error?: string }>;
  resetLogCache: () => Promise<{ success: boolean }>;
  
  // Folder access
  openLogsFolder: () => Promise<{ success: boolean }>;
  openConfigFolder: () => Promise<{ success: boolean }>;
  openVSPluginsFolder: () => Promise<{ success: boolean }>;
  openVSScriptsFolder: () => Promise<{ success: boolean }>;

  // DLSS 5 Neural Uplift runtime (nvngx_dlssnr.dll)
  dlssRuntimeStatus: () => Promise<DlssRuntimeStatus>;
  dlssRuntimeImport: () => Promise<DlssImportResult>;

  // Post-update notice
  getUpdateReport: () => Promise<UpdateReportSnapshot>;
  markUpdateReportSeen: () => Promise<void>;
  clearUpdateReport: () => Promise<void>;
  resolveTemplateDecision: (file: string, choice: TemplateDecisionChoice) => Promise<UpdateReportSnapshot & { backupPath?: string }>;
  openTemplateBackups: () => Promise<void>;
  /** Built-in filter files this install deleted, which updates never restore */
  getMissingBundledTemplates: () => Promise<string[]>;
  /** Puts them back; answers the files restored */
  restoreMissingBundledTemplates: () => Promise<string[]>;
  
  // Console logs
  onDevConsoleLog: (callback: (log: DevConsoleLog) => void) => () => void;
  
  // Colorimetry settings
  getColorimetrySettings: () => Promise<ColorimetrySettings>;
  setColorimetrySettings: (settings: ColorimetrySettings) => Promise<{ success: boolean }>;
  
  // FFmpeg configuration
  getFfmpegArgs: () => Promise<{ args: string }>;
  setFfmpegArgs: (args: string) => Promise<{ success: boolean }>;
  getDefaultFfmpegArgs: () => Promise<{ args: string }>;
  
  // Processing format
  getProcessingFormat: () => Promise<{ format: string }>;
  setProcessingFormat: (format: string) => Promise<{ success: boolean }>;

  // Output format
  getOutputFormat: () => Promise<{ format: string }>;
  setOutputFormat: (format: string) => Promise<{ success: boolean }>;

  // Video compare configuration
  getVideoCompareArgs: () => Promise<{ args: string }>;
  setVideoCompareArgs: (args: string) => Promise<{ success: boolean }>;
  getDefaultVideoCompareArgs: () => Promise<{ args: string }>;

  // Default output folder
  getDefaultOutputFolder: () => Promise<{ folder: string | null }>;
  setDefaultOutputFolder: (folder: string | null) => Promise<{ success: boolean }>;

  // Descriptive naming
  /** Which ROCm the MIGraphX backend runs against (Linux only), with what it resolves to */
  getRocmSetting: () => Promise<RocmSettingResult>;
  setRocmSetting: (setting: RocmSetting) => Promise<RocmSettingResult>;
  getDescriptiveNamingEnabled: () => Promise<{ enabled: boolean }>;
  setDescriptiveNamingEnabled: (enabled: boolean) => Promise<{ success: boolean }>;

  // Discord Rich Presence
  getDiscordRichPresenceSettings: () => Promise<DiscordRichPresenceSettings>;
  setDiscordRichPresenceSettings: (settings: DiscordRichPresenceSettings) => Promise<{ success: boolean; error?: string }>;
  setDiscordRichPresenceActivity: (activity: DiscordRichPresenceActivity) => Promise<{ success: boolean }>;
  clearDiscordRichPresence: () => Promise<{ success: boolean }>;

  // Encoding settings panel state
  getEncodingSettingsExpanded: () => Promise<{ expanded: boolean }>;
  setEncodingSettingsExpanded: (expanded: boolean) => Promise<{ success: boolean }>;
  getDefaultVideoCompareArgs: () => Promise<{ args: string }>;

  // Panel sizes
  getPanelSizes: () => Promise<{ leftPanel: number; rightPanel: number; queuePanel?: number }>;
  setPanelSizes: (sizes: { leftPanel: number; rightPanel: number; queuePanel?: number }) => Promise<{ success: boolean }>;
  
  // Queue UI state
  getShowQueue: () => Promise<{ show: boolean }>;
  setShowQueue: (show: boolean) => Promise<{ success: boolean }>;
  
  // Filter configurations
  getFilterConfigurations: () => Promise<Filter[]>;
  setFilterConfigurations: (filters: Filter[]) => Promise<{ success: boolean }>;
  
  // Backend operations
  reloadBackend: () => Promise<{ success: boolean; error?: string }>;
  
  // Filter template operations
  getFilterTemplates: () => Promise<FilterTemplate[]>;
  saveFilterTemplate: (template: FilterTemplate) => Promise<{ success: boolean; error?: string }>;
  deleteFilterTemplate: (name: string) => Promise<{ success: boolean; error?: string }>;
  readTemplateFile: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>;
  importTemplateFile: (filePath: string) => Promise<{ success: boolean; template?: FilterTemplate; error?: string }>;
  
  // Model category operations
  getModelCategories: () => Promise<string[]>;
  updateModelCategory: (modelId: string, category: string | string[] | undefined) => Promise<{ success: boolean; error?: string }>;

  // File operations
  fileExists: (filePath: string) => Promise<boolean>;
  
  // Workflow operations
  exportWorkflow: (workflow: WorkflowData, filePath: string) => Promise<{ success: boolean; error?: string }>;
  importWorkflow: (filePath: string) => Promise<{ success: boolean; workflow?: WorkflowData; error?: string }>;
  selectWorkflowFile: (mode: 'open' | 'save') => Promise<string | null>;
  /** Colour lookup tables. The text crosses the boundary unparsed, so the
      renderer's tested parser is the only one, and its errors reach the UI. */
  selectLutFile: (mode: 'open' | 'save', defaultName?: string) => Promise<string | null>;
  writeLutFile: (filePath: string, text: string) =>
    Promise<{ success: true; path: string } | { success: false; error: string }>;
  readLutFile: (filePath: string) =>
    Promise<{ success: true; text: string; name: string } | { success: false; error: string }>;
  installLut: (name: string, text: string) =>
    Promise<{ success: true; path: string; name: string } | { success: false; error: string }>;
  
  // Plugin dependency operations
  /**
   * `partial` (the default) installs what is missing and keeps every filter
   * and script the user changed; `complete` reinstalls the plugin packages
   * from scratch and puts every shipped filter and script back to stock.
   */
  installPluginDependencies: (mode?: 'partial' | 'complete') => Promise<InstallResult>;
  retrySetupPlugins: () => Promise<InstallResult>;
  uninstallPluginDependencies: () => Promise<InstallResult>;
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
  updateVsMlrtPlugin: () => Promise<{ success: boolean; version?: string; error?: string }>;
  onVsMlrtUpdateProgress: (callback: (progress: { progress: number; message: string }) => void) => () => void;
}

/** What the last app update did on its own; see electron/installLedger.ts. */
export interface UpdateReport {
  /** null when the install predates version tracking */
  fromVersion: string | null;
  toVersion: string;
  createdAt: string;
  seen: boolean;
  templatesAdded: string[];
  templatesUpdated: string[];
  templatesRemoved: string[];
  packagesInstalled: string[];
  pluginsUpdated: string[];
  scriptsUpdated: string[];
  /** Scripts the user edited, left as they were */
  scriptsKept: string[];
}

/** An edited filter template the update left for the user; see electron/templateReconcile.ts. */
export interface TemplateDecision {
  file: string;
  name: string;
  kind: 'edited-outdated' | 'edited-dropped';
  replacement?: string;
}

export type TemplateDecisionChoice = 'replace' | 'keep' | 'remove';

export interface UpdateReportSnapshot {
  report: UpdateReport | null;
  decisions: TemplateDecision[];
}

export interface DlssRuntimeStatus {
  installed: boolean;
  installedVersion: string | null;
  /** Where the runtime goes, so a user who would rather copy it themselves can. */
  targetDirectory: string;
}

export interface DlssImportResult {
  success: boolean;
  canceled?: boolean;
  error?: string;
  version?: string | null;
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

/** How an install, uninstall or setup phase ended (electron/installFlow.ts). */
export interface InstallResult {
  success: boolean;
  /** summary plus where the full log is */
  error?: string;
  /** One sentence saying what went wrong and what to do */
  summary?: string;
  /** The output lines the summary was drawn from */
  evidence?: string;
  logPath?: string;
  cancelled?: boolean;
  alreadyRunning?: boolean;
  blocked?: boolean;
  warnings?: string[];
}

/** An install failure as the UI shows it: the sentence up front, the evidence behind "Details". */
export interface InstallFailureInfo {
  summary: string;
  evidence?: string;
  logPath?: string;
}

export interface SetupProgress {
  // 'retrying': an attempt failed and another is starting; 'warning': worth
  // showing, stops nothing. Only 'complete' and 'error' end a phase.
  type: 'download' | 'extract' | 'installing' | 'python-setup' | 'retrying' | 'warning' | 'complete' | 'error' | 'model-extract';
  component: string;
  progress: number;
  message: string;
  summary?: string;
  evidence?: string;
  logPath?: string;
  warnings?: string[];
}

/** One selectable step of the chain, as the open script exposes it. */
export interface PreviewPlayOptions {
  /** Caller-assigned id, echoed on every frame so stale ones can be dropped. */
  stream: number;
  output: number;
  /** First frame, in the output's own numbering. */
  from: number;
  width: number;
  /** Frames the server may send before it waits for more credit. */
  credits: number;
  prefetch?: number;
}

/** What arrives on the playback port. */
export type PreviewStreamMessage =
  | {
      type: 'pframe';
      stream: number;
      n: number;
      output: number;
      width: number;
      height: number;
      data: Uint8Array;
    }
  | { type: 'end'; stream: number; n: number | null }
  | { type: 'error'; stream: number; n: number; error: string };

export interface PreviewOutput {
  /** Script output index: 0 is the source, then one per enabled filter. */
  index: number;
  width: number;
  height: number;
  frames: number;
  fpsNum: number;
  fpsDen: number;
  format: string | null;
}

/** Floor, ceiling and 0.1/99.9 percentiles, in 8-bit code values. */
export interface PreviewSpread {
  min: number;
  max: number;
  low: number;
  high: number;
}

/**
 * Where the picture actually sits. Luma is the one that answers "are these
 * blacks raised": on anything with saturated colour, a single channel's floor
 * is set by the primaries rather than by the shadows.
 */
export interface PreviewLevels {
  r: PreviewSpread;
  g: PreviewSpread;
  b: PreviewSpread;
  y: PreviewSpread;
}

/** How the clip feeding a step is tagged, before the conversion to RGB. */
export interface PreviewSourceProps {
  /** VapourSynth's convention: 0 full, 1 limited, null when untagged. */
  colorRange: number | null;
  matrix: number | null;
  transfer: number | null;
  primaries: number | null;
  format: string | null;
}

/** A rendered preview frame: packed RGB24, three bytes per pixel, no padding. */
export interface PreviewFrameResult {
  success: boolean;
  error?: string;
  n?: number;
  width?: number;
  height?: number;
  output?: number;
  data?: Uint8Array;
  levels?: PreviewLevels | null;
  source?: PreviewSourceProps | null;
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
  frameCount?: number;
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
  metadataId?: string;
  name: string;
  path: string;
  precision: string;
  backend: 'tensorrt' | 'onnx';
  hasEngine?: boolean;
  modelType?: 'vsr' | 'image';
  displayTag?: string;
  description?: string;
  category?: string | string[];
}

export interface ModelMetadata {
  useFp32: boolean;
  useBf16?: boolean;
  modelType: 'vsr' | 'image';
  temporalFrames?: number; // Number of frames for VSR models (default: 5)
  displayTag?: string;
  description?: string;
  category?: string | string[];
  createdAt?: string;
}

export interface UninitializedModel {
  id: string;
  name: string;
  onnxPath: string;
  modelType?: 'vsr' | 'image';
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
  modelType?: 'vsr' | 'image';
  temporalFrames?: number;
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
  inputDataType?: string;
  /**
   * Build precision resolved in the main process from the model name and the
   * ONNX weights. Undefined when neither says - the input data type alone is
   * not enough, since FP16 and BF16 exports keep FP32 inputs.
   */
  precision?: 'fp16' | 'bf16' | 'fp32';
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
  modelType?: 'vsr' | 'image';
  temporalFrames?: number;
  backend?: BackendId;
  displayTag?: string;
  useStaticShape?: boolean;
  useCustomTrtexecParams?: boolean;
  customTrtexecParams?: string;
  skipValidation?: boolean;
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

/**
 * Status of a TensorRT engine being built at runtime inside vspipe, parsed from
 * the `[vk-build]` stderr protocol (see electron/engineBuildProtocol.ts).
 * `percent` is absent when the emitting tool reports no progress.
 */
export interface EngineBuildStatus {
  status: 'building' | 'idle';
  label?: string;
  percent?: number;
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
  eta?: number | null; // Estimated seconds remaining, null if not yet calculable
  gpuMemoryUsed?: number; // GPU VRAM used in MB
  gpuMemoryTotal?: number; // GPU VRAM total in MB
  gpuUtilization?: number; // GPU utilization percentage 0-100
}

export interface UpscaleResult {
  success: boolean;
  outputPath?: string;
  error?: string;
}

export interface Filter {
  id: string;
  enabled: boolean;
  /** 'videoSource' is a Load Video step, which heads a side chain (electron/chainGraph.ts). */
  filterType: 'aiModel' | 'custom' | 'videoSource';
  preset: string;
  code: string;
  order: number;
  /** A Load Video step's file. */
  sourcePath?: string;
  /** The Load Video step whose side chain this step is in; absent for the main chain. */
  chain?: string;
  modelPath?: string;
  modelType?: 'vsr' | 'image';
  category?: string | string[];
  /** Inference backend override; 'auto' or unset inherits the app default. */
  backend?: FilterBackend;
  /** num_streams override for this AI model; unset inherits the app default. */
  numStreams?: number;
  /** Values supplied to {{variable}} placeholders in this filter's code. */
  parameters?: FilterParameterValues;
  /** Public variables declared by the .vkfilter template. */
  variables?: FilterVariables;
  /** Optional visual editor declared by the .vkfilter template. */
  editor?: FilterEditor;
}

export interface DiscordRichPresenceSettings {
  enabled: boolean;
}

export interface DiscordRichPresenceActivity {
  details?: string;
  state?: string;
  /** Unix timestamp in seconds. */
  startTimestamp?: number;
}

export type FilterParameterValue = string | number | boolean;
export type FilterParameterValues = Record<string, FilterParameterValue>;

/** A variable a .vkfilter intentionally exposes to the application UI. */
export interface FilterVariable {
  type?: 'number' | 'string' | 'boolean';
  default?: FilterParameterValue;
  description?: string;
  /**
   * Declared for the generator, not for a person to type.
   *
   * A step id, a path the file picker wrote, a fingerprint the app compares
   * against — the value is the app's to keep, and offering it as a text box
   * only lets someone edit a working step into a broken one. It stays in
   * [variables] because the generated code still substitutes it; it just does
   * not appear as a control.
   */
  hidden?: boolean;
}

export type FilterVariables = Record<string, FilterVariable>;

/**
 * Visual editors are opt-in template metadata. More editor kinds can be added
 * without teaching a filter's Python code about the renderer implementation.
 * Every editor maps its own roles onto the template's variable names, so the
 * emitted Python stays readable and editable by hand.
 */
export interface CropFilterEditor {
  type: 'crop';
  label?: string;
  variables: {
    left: string;
    right: string;
    top: string;
    bottom: string;
  };
}

/** A trackball's four variables, in R, G, B, master order. */
export type ColorGradeBallVariables = [string, string, string, string];

export interface ColorGradeFilterEditor {
  type: 'colorGrade';
  label?: string;
  variables: {
    lift: ColorGradeBallVariables;
    gamma: ColorGradeBallVariables;
    gain: ColorGradeBallVariables;
    offset: ColorGradeBallVariables;
    temperature: string;
    tint: string;
    contrast: string;
    pivot: string;
    saturation: string;
    hue: string;
    brightness: string;
  };
}

/**
 * A Create LUT step. It remembers the colour where it sits and holds nothing
 * about any table but how finely the colour work above it is sampled when
 * that is saved as a file.
 */
export interface CreateLutFilterEditor {
  type: 'createLut';
  label?: string;
  variables: {
    size: string;
    frames: string;
  };
}

/**
 * A Load LUT step's table, and how it was made.
 *
 * `source` is the Create LUT whose colour this puts back and `path` is the
 * file actually applied. The path is what the Python reads — a step id means
 * nothing to VapourSynth — and the app writes it when the step generates,
 * with `generatedKey` recording what sat between the two so the step can
 * say when the chain has moved out from under its table.
 */
export interface LutSourceFilterEditor {
  type: 'lutSource';
  label?: string;
  variables: {
    source: string;
    path: string;
    size: string;
    frames: string;
    generatedKey: string;
  };
}

/**
 * A step that reads the picture from another step of the chain.
 *
 * `source` names the variable holding that step's filter id; empty means the
 * source, before anything. An id rather than a position, because a position
 * stops being true the moment something above it moves — and the emitted
 * Python answers every way an id can stop naming a usable step by message
 * rather than by a KeyError.
 *
 * Deliberately one variable and nothing else. The reference is the whole of
 * what this editor knows; what a filter does with the clip it gets back is
 * the filter's own business.
 */
export interface StageSourceFilterEditor {
  type: 'stageSource';
  label?: string;
  /**
   * Also offer a video file outside the chain, held in the same variable
   * (electron/referenceVideo.ts). Only for a filter whose code copes with a
   * picture of a different size; the file is fitted to the source's length.
   */
  videoFile?: boolean;
  variables: {
    source: string;
  };
}

export type FilterEditor =
  | CropFilterEditor
  | ColorGradeFilterEditor
  | CreateLutFilterEditor
  | LutSourceFilterEditor
  | StageSourceFilterEditor;

export interface SegmentSelection {
  enabled: boolean;
  startFrame: number;
  endFrame: number; // -1 means end of video
}

export interface ColorimetrySettings {
  overwriteMatrix: boolean;
  matrix709: boolean;
  defaultMatrix: '709' | '170m';
  defaultPrimaries: '709' | '601';
  defaultTransfer: '709' | '170m';
}

export interface FilterTemplate {
  name: string;
  code: string;
  category?: string | string[]; // Can be a single category or multiple categories
  description?: string;
  variables?: FilterVariables;
  editor?: FilterEditor;
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
    /**
     * The filter's id at the time of export, carried only so that a step
     * naming another step still names it once the import hands out new ones.
     * Optional: workflows written before references existed have none.
     */
    id?: string;
    name: string;
    code: string;
    description?: string;
    enabled: boolean;
    order: number;
    filterType: 'aiModel' | 'custom' | 'videoSource';
    /** A Load Video step's file. Absolute, so a workflow moved to another machine names it as it was. */
    sourcePath?: string;
    /** The exported id of the Load Video step heading this step's side chain. */
    chain?: string;
    modelPath?: string;
    modelType?: 'vsr' | 'image';
    category?: string | string[];
    backend?: FilterBackend;
    numStreams?: number;
    parameters?: FilterParameterValues;
    variables?: FilterVariables;
    editor?: FilterEditor;
  }[];
  createdAt?: string;
  description?: string;
  // Encoding settings
  encodingSettings?: {
    ffmpegArgs?: string;
    processingFormat?: string;
    outputFormat?: string;
    videoCompareArgs?: string;
    defaultBackend?: BackendId;
    numStreams?: number;
    segment?: SegmentSelection;
    colorimetry?: ColorimetrySettings;
  };
}

export interface PluginDependencyProgress {
  type: 'installing' | 'retrying' | 'warning' | 'complete' | 'error';
  progress: number;
  message: string;
  summary?: string;
  evidence?: string;
  logPath?: string;
  warnings?: string[];
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
    ffmpegArgs: string;
    processingFormat: string;
    outputFormat: string;
    videoCompareArgs: string;
    defaultBackend: BackendId;
    /** Legacy field from pre-backend-registry queue files; migrated on load. */
    useDirectML?: boolean;
    numStreams: number;
    segment?: SegmentSelection;
    colorimetry?: ColorimetrySettings;
  };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
