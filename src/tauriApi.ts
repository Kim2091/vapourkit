// src/tauriApi.ts
//
// Compatibility shim: implements window.electronAPI using Tauri's invoke/listen.
// This lets the entire existing frontend work without changing every file.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type {
  ElectronAPI,
  SetupProgress,
  VideoInfo,
  ModelFile,
  UninitializedModel,
  InitializeModelParams,
  InitializeModelResult,
  ImportModelParams,
  ImportModelResult,
  ModelInitProgress,
  ModelImportProgress,
  ModelMetadata,
  ValidateOnnxModelResult,
  UpscaleProgress,
  UpscaleResult,
  Filter,
  SegmentSelection,
  ColorimetrySettings,
  FilterTemplate,
  WorkflowData,
  PluginDependencyProgress,
  QueueItem,
  VsMlrtVersionInfo,
  DevConsoleLog,
} from './electron.d';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Wrap a Tauri `listen` call into the shape `(cb) => unsubscribe` that the frontend expects. */
function makeTauriListener<T>(eventName: string) {
  return (callback: (payload: T) => void): (() => void) => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    listen<T>(eventName, (ev) => {
      callback(ev.payload);
    }).then((fn) => {
      if (cancelled) {
        fn(); // component already unmounted — clean up immediately
      } else {
        unlisten = fn;
      }
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  };
}

/**
 * Cache of file paths from Tauri drag-drop events.
 * Maps file name to full path for getFilePathFromFile.
 */
const dragDropPathCache: Map<string, string> = new Map();

/** Initialize Tauri drag-drop event listener to capture file paths. */
function initDragDropListener() {
  const webview = getCurrentWebviewWindow();
  let lastDragTarget: Element | null = null;
  // Paths carried by the current drag gesture (populated on 'enter', reused on 'over').
  let currentDragPaths: string[] = [];

  /** Build a DataTransfer pre-populated with File stubs so that
   *  e.dataTransfer is never null and e.dataTransfer.types includes 'Files'. */
  function buildDragDataTransfer(paths: string[]): DataTransfer {
    const dt = new DataTransfer();
    for (const p of paths) {
      const name = p.split(/[\\/]/).pop() || p;
      dt.items.add(new File([], name));
    }
    return dt;
  }

  webview.onDragDropEvent((event) => {
    const payload = event.payload as any;
    const type: string = payload.type;
    const pos: { x: number; y: number } = payload.position ?? { x: 0, y: 0 };

    if (type === 'enter' || type === 'over') {
      // 'enter' often carries paths; 'over' usually doesn't – reuse what we cached.
      if (payload.paths && (payload.paths as string[]).length > 0) {
        currentDragPaths = payload.paths as string[];
      }
      const dt = buildDragDataTransfer(currentDragPaths);
      // Show the drag-over highlight in whichever drop zone the cursor is over.
      const target = document.elementFromPoint(pos.x, pos.y) ?? document.body;
      lastDragTarget = target;
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: pos.x, clientY: pos.y, dataTransfer: dt }));

    } else if (type === 'leave') {
      // Cursor left the window — fire dragleave on the last known target so
      // React clears the drag-highlight state.
      const target = lastDragTarget ?? document.body;
      lastDragTarget = null;
      currentDragPaths = [];
      target.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true }));

    } else if (type === 'drop') {
      const paths: string[] = payload.paths ?? [];
      lastDragTarget = null;
      currentDragPaths = [];

      // 1. Populate the path cache so getFilePathFromFile can resolve names → paths.
      dragDropPathCache.clear();
      for (const p of paths) {
        const name = p.split(/[\\/]/).pop() || p;
        dragDropPathCache.set(name, p);
      }

      // 2. Build a DataTransfer with empty File stubs (real content is not needed;
      //    only the file.name is used by getFilePathFromFile to look up the cached path).
      const dt = new DataTransfer();
      for (const p of paths) {
        const name = p.split(/[\\/]/).pop() || p;
        dt.items.add(new File([], name));
      }

      // 3. Dispatch a native drop event so React's onDrop handler fires normally.
      const target = document.elementFromPoint(pos.x, pos.y) ?? document.body;
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: pos.x, clientY: pos.y, dataTransfer: dt }));
    }
  });
}

// ─── The bridge ───────────────────────────────────────────────────────────────

const tauriApi: ElectronAPI = {
  // ── Dependency management ───────────────────────────────────────────────────
  checkDependencies: async () => {
    const r = await invoke<{ allPresent: boolean }>('check_dependencies');
    return r.allPresent;
  },
  setupDependencies: () => invoke('setup_dependencies'),
  onSetupProgress: makeTauriListener<SetupProgress>('setup-progress'),
  detectCudaSupport: () => invoke<boolean>('detect_cuda_support'),

  // ── Video / file selection dialogs ──────────────────────────────────────────
  selectVideoFile: () => invoke<string[] | null>('select_video_file'),
  selectOnnxFile: () => invoke<string | null>('select_onnx_file'),
  selectTemplateFile: () => invoke<string | null>('select_template_file'),
  selectOutputFile: (defaultName: string) =>
    invoke<string | null>('select_output_file', { defaultName }),
  selectFolder: () => invoke<string | null>('select_folder'),
  selectWorkflowFile: (mode: 'open' | 'save') =>
    invoke<string | null>('select_workflow_file', { mode }),

  // ── Video operations ────────────────────────────────────────────────────────
  getVideoInfo: (filePath: string) =>
    invoke<VideoInfo>('get_video_info', { filePath }),
  readVideoFile: (filePath: string) =>
    invoke<number[]>('read_video_file', { filePath }).then(
      (bytes) => new Uint8Array(bytes).buffer as ArrayBuffer
    ),
  getVideoThumbnail: (filePath: string) =>
    invoke<string | null>('get_video_thumbnail', { videoPath: filePath }),
  getVideoFrameAt: (filePath: string, frameNumber: number, fps: number) =>
    invoke<string | null>('get_video_frame_at', { videoPath: filePath, frameNumber, fps }),
  getOutputResolution: (
    videoPath: string,
    modelPath: string | null,
    useDirectML?: boolean,
    upscalingEnabled?: boolean,
    filters?: Filter[],
    upscalePosition?: number,
    numStreams?: number,
    sourceFps?: number,
  ) =>
    invoke('get_output_resolution', {
      videoPath,
      modelPath,
      useDirectMl: useDirectML,
      upscalingEnabled,
      filters,
      upscalePosition,
      numStreams,
      sourceFps,
    }),
  cancelValidation: () => invoke('cancel_validation'),
  getFilePathFromFile: (file: File) => {
    // In Tauri, try to get the path from our drag-drop cache first
    const cached = dragDropPathCache.get(file.name);
    if (cached) return cached;
    // Fallback: some Tauri webviews may expose .path on File
    return (file as any).path ?? '';
  },

  // ── Model operations ───────────────────────────────────────────────────────
  getAvailableModels: () => invoke<ModelFile[]>('get_available_models'),
  getUninitializedModels: () =>
    invoke<UninitializedModel[]>('get_uninitialized_models'),
  initializeModel: (params: InitializeModelParams) =>
    invoke<InitializeModelResult>('initialize_model', { params }),
  importCustomModel: (params: ImportModelParams) =>
    invoke<ImportModelResult>('import_custom_model', { params }),
  getModelMetadata: (modelId: string) =>
    invoke<ModelMetadata | null>('get_model_metadata', { modelId }),
  updateModelMetadata: (
    modelId: string,
    metadata: Partial<ModelMetadata>,
  ) => invoke('update_model_metadata', { modelId, metadata }),
  deleteModel: (modelPath: string, modelId: string) =>
    invoke('delete_model', { modelPath, modelId }),
  cancelModelImport: () => invoke('cancel_model_import'),
  forceStopModelImport: () => invoke('force_stop_model_import'),
  validateOnnxModel: (onnxPath: string) =>
    invoke<ValidateOnnxModelResult>('validate_onnx_model', { onnxPath }),
  onModelInitProgress: makeTauriListener<ModelInitProgress>('model-init-progress'),
  onModelImportProgress: makeTauriListener<ModelImportProgress>('model-import-progress'),

  // ── Upscale operations ──────────────────────────────────────────────────────
  startUpscale: (
    videoPath: string,
    modelPath: string | null,
    outputPath: string,
    useDirectML?: boolean,
    upscalingEnabled?: boolean,
    filters?: Filter[],
    upscalePosition?: number,
    numStreams?: number,
    segment?: SegmentSelection,
  ) =>
    invoke<UpscaleResult>('start_upscale', {
      videoPath,
      modelPath,
      outputPath,
      useDirectMl: useDirectML,
      upscalingEnabled,
      filters,
      upscalePosition,
      numStreams,
      segment,
    }),
  previewSegment: (
    videoPath: string,
    modelPath: string | null,
    useDirectML?: boolean,
    upscalingEnabled?: boolean,
    filters?: Filter[],
    numStreams?: number,
    startFrame?: number,
    endFrame?: number,
  ) =>
    invoke('preview_segment', {
      videoPath,
      modelPath,
      useDirectMl: useDirectML,
      upscalingEnabled,
      filters,
      numStreams,
      startFrame,
      endFrame,
    }),
  cancelUpscale: () => invoke('cancel_upscale'),
  killUpscale: () => invoke('kill_upscale'),
  onUpscaleProgress: makeTauriListener<UpscaleProgress>('upscale-progress'),

  // ── Folder / shell ──────────────────────────────────────────────────────────
  openOutputFolder: (filePath: string) =>
    invoke<void>('open_output_folder', { filePath }),
  openLogsFolder: () => invoke('open_logs_folder'),
  openConfigFolder: () => invoke('open_config_folder'),
  openVSPluginsFolder: () => invoke('open_vs_plugins_folder'),
  openVSScriptsFolder: () => invoke('open_vs_scripts_folder'),
  openExternal: (url: string) => invoke<void>('open_external', { url }),
  compareVideos: (inputPath: string, outputPath: string) =>
    invoke('compare_videos', { inputPath, outputPath }),
  launchVsePreviewer: (
    videoPath: string,
    modelPath: string | null,
    useDirectML?: boolean,
    upscalingEnabled?: boolean,
    filters?: Filter[],
    numStreams?: number,
    segment?: SegmentSelection,
  ) =>
    invoke('launch_vse_previewer', {
      videoPath,
      modelPath,
      useDirectMl: useDirectML,
      upscalingEnabled,
      filters,
      numStreams,
      segment,
    }),

  // ── App info / logs ─────────────────────────────────────────────────────────
  getVersion: () => invoke('get_version'),
  readLogTail: (maxLines?: number) =>
    invoke('read_log_tail', { maxLines: maxLines ?? 300 }),
  resetLogCache: () => invoke('reset_log_cache'),

  // ── Colorimetry ─────────────────────────────────────────────────────────────
  getColorimetrySettings: () => invoke<ColorimetrySettings>('get_colorimetry_settings'),
  setColorimetrySettings: (settings: ColorimetrySettings) =>
    invoke('set_colorimetry_settings', { settings }),

  // ── FFmpeg / processing config ──────────────────────────────────────────────
  getFfmpegArgs: () => invoke('get_ffmpeg_args'),
  setFfmpegArgs: (args: string) => invoke('set_ffmpeg_args', { args }),
  getDefaultFfmpegArgs: () => invoke('get_default_ffmpeg_args'),
  getProcessingFormat: () => invoke('get_processing_format'),
  setProcessingFormat: (format: string) =>
    invoke('set_processing_format', { format }),
  getOutputFormat: () => invoke('get_output_format'),
  setOutputFormat: (format: string) => invoke('set_output_format', { format }),
  getVideoCompareArgs: () => invoke('get_video_compare_args'),
  setVideoCompareArgs: (args: string) =>
    invoke('set_video_compare_args', { args }),
  getDefaultVideoCompareArgs: () => invoke('get_default_video_compare_args'),
  getDefaultOutputFolder: () => invoke('get_default_output_folder'),
  setDefaultOutputFolder: (folder: string | null) =>
    invoke('set_default_output_folder', { folder }),
  getEncodingSettingsExpanded: () => invoke('get_encoding_settings_expanded'),
  setEncodingSettingsExpanded: (expanded: boolean) =>
    invoke('set_encoding_settings_expanded', { expanded }),

  // ── Panel / UI state ────────────────────────────────────────────────────────
  getPanelSizes: () => invoke('get_panel_sizes'),
  setPanelSizes: (sizes) => invoke('set_panel_sizes', { sizes }),
  getShowQueue: () => invoke('get_show_queue'),
  setShowQueue: (show: boolean) => invoke('set_show_queue', { show }),
  getFilterConfigurations: () => invoke<Filter[]>('get_filter_configurations'),
  setFilterConfigurations: (filters: Filter[]) =>
    invoke('set_filter_configurations', { filters }),

  // ── Backend ─────────────────────────────────────────────────────────────────
  reloadBackend: () => invoke('reload_backend'),

  // ── Filter templates ────────────────────────────────────────────────────────
  getFilterTemplates: () => invoke<FilterTemplate[]>('get_filter_templates'),
  saveFilterTemplate: (template: FilterTemplate) =>
    invoke('save_filter_template', { template }),
  deleteFilterTemplate: (name: string) =>
    invoke('delete_filter_template', { name }),
  readTemplateFile: (filePath: string) =>
    invoke('read_template_file', { filePath }),
  importTemplateFile: (filePath: string) =>
    invoke('import_template_file', { filePath }),

  // ── Model categories ────────────────────────────────────────────────────────
  getModelCategories: () => invoke<string[]>('get_model_categories'),
  updateModelCategory: (
    modelId: string,
    category: string | string[] | undefined,
  ) => invoke('update_model_category', { modelId, category }),

  // ── File operations ─────────────────────────────────────────────────────────
  fileExists: (filePath: string) => invoke<boolean>('file_exists', { filePath }),

  // ── Workflow operations ─────────────────────────────────────────────────────
  exportWorkflow: (workflow: WorkflowData, filePath: string) =>
    invoke('export_workflow', { workflow, filePath }),
  importWorkflow: (filePath: string) =>
    invoke('import_workflow', { filePath }),

  // ── Plugin dependencies ─────────────────────────────────────────────────────
  installPluginDependencies: () => invoke('install_plugin_dependencies', { packages: [] }),
  uninstallPluginDependencies: () => invoke('uninstall_plugin_dependencies', { packages: [] }),
  checkPluginDependencies: () =>
    invoke<{ installed: boolean; packages: string[] }>('check_plugin_dependencies', { packages: [] }),
  cancelPluginDependencyInstall: () => invoke('cancel_plugin_dependency_install'),
  onPluginDependencyProgress: makeTauriListener<PluginDependencyProgress>(
    'plugin-dependency-progress',
  ),

  // ── Update operations ───────────────────────────────────────────────────────
  checkForUpdates: () => invoke('check_for_updates'),
  openReleasesPage: () => invoke('open_releases_page'),
  openReleaseUrl: (url: string) => invoke('open_release_url', { url }),

  // ── Queue operations ────────────────────────────────────────────────────────
  getQueue: () => invoke<QueueItem[]>('get_queue'),
  saveQueue: (queue: QueueItem[]) => invoke('save_queue', { queue }),
  clearQueue: () => invoke('clear_queue'),

  // ── vs-mlrt version ─────────────────────────────────────────────────────────
  checkVsMlrtVersion: () => invoke<VsMlrtVersionInfo>('check_vsmlrt_version'),
  clearEngineFiles: () => invoke('clear_engine_files'),
  updateVsMlrtVersion: () => invoke('update_vsmlrt_version'),
  updateVsMlrtPlugin: () => invoke('update_vsmlrt_plugin'),
  onVsMlrtUpdateProgress: makeTauriListener<{ progress: number; message: string }>(
    'vsmlrt-update-progress',
  ),

  // ── Console logs (no-op for Tauri — logs go through tauri-plugin-log) ──────
  onDevConsoleLog: (_callback: (log: DevConsoleLog) => void) => {
    // In Tauri all backend logs go through the log plugin; this is a no-op.
    return () => {};
  },

  // ── Video filter (config) ──────────────────────────────────────────────────
  getVideoFilter: () => invoke('get_video_filter'),
  setVideoFilter: (filter: string | null) =>
    invoke('set_video_filter', { filter }),
} as ElectronAPI & { getVideoFilter: () => Promise<any>; setVideoFilter: (f: string | null) => Promise<any> };

// ─── Install on window ───────────────────────────────────────────────────────

export function installTauriApi() {
  (window as any).electronAPI = tauriApi;
  initDragDropListener();
}
