// electron/providers/descriptors.ts
//
// Inference backend metadata shared by the electron main process AND the
// renderer (src/ imports this file directly, so it must stay PURE DATA —
// no node/electron imports).
//
// Adding a new inference backend:
//   1. Add its id to BackendId and a descriptor entry to BACKENDS below.
//   2. Create electron/providers/<id>.ts implementing InferenceProvider.
//   3. Register it in electron/providers/registry.ts.
// Everything else — the header dropdown, per-filter overrides, model list
// filtering, import modal options, script generation, plugin install — is
// driven by this metadata and the provider module. No other files need edits.

export type BackendId = 'tensorrt' | 'directml' | 'ncnn'; // future: | 'openvino'
export type BackendPlatform = 'win32' | 'linux';

/** Sentinel for per-filter backend selection: inherit the app-level default. */
export type FilterBackend = BackendId | 'auto';

export interface BackendDescriptor {
  id: BackendId;
  /** Operating systems on which this provider is supported by Vapourkit. */
  supportedPlatforms: readonly BackendPlatform[];
  /** Full name shown in dropdowns, e.g. "TensorRT". */
  label: string;
  /** Compact badge label, e.g. "TRT". */
  shortLabel: string;
  /** One-line description shown in selector tooltips/menus. */
  description: string;
  /**
   * Whether models must be pre-built into backend-specific files (.engine)
   * before inference. Drives the import modal's build options, the
   * [Unbuilt] model labels, and build notifications.
   */
  requiresEngineBuild: boolean;
  /** Whether the backend loads .onnx files directly (no build step). */
  runsOnnxDirectly: boolean;
  /** Precisions selectable when importing a model for this backend. */
  importPrecisions: Array<'fp16' | 'bf16' | 'fp32'>;
  /** Whether the import modal should offer min/opt/max shape configuration. */
  supportsShapes: boolean;
  /** Whether the import modal should offer custom build (trtexec) parameters. */
  supportsCustomBuildParams: boolean;
  /**
   * vsmlrt.Backend attribute for this backend — used to generate the
   * vk_backend() helper injected into VapourSynth scripts so .vkfilter code
   * can follow the app-selected backend. This may differ from the plugin the
   * main upscale step uses when the script-side vsmlrt path has extra
   * requirements (see the tensorrt entry).
   */
  vsmlrtBackendAttr: string;
}

export const BACKENDS: readonly BackendDescriptor[] = [
  {
    id: 'tensorrt',
    supportedPlatforms: ['win32', 'linux'],
    label: 'TensorRT',
    shortLabel: 'TRT',
    description: 'NVIDIA TensorRT — fastest on NVIDIA RTX GPUs, models are pre-built into engines',
    requiresEngineBuild: true,
    runsOnnxDirectly: false,
    importPrecisions: ['fp16', 'bf16', 'fp32'],
    supportsShapes: true,
    supportsCustomBuildParams: true,
    // vsmlrt's script-side TRT backend builds engines at runtime via trtexec,
    // which the TensorRT pip wheels don't ship — the app writes a trtexec shim
    // that routes those builds through its own Python API builder instead (see
    // electron/trtexecShim.ts), and the [vk-build] banner makes the first build
    // at each resolution visible rather than looking like a freeze. Switching
    // this back to 'ORT_CUDA' is the one-line revert if TRT-for-script-filters
    // ever proves painful.
    vsmlrtBackendAttr: 'TRT',
  },
  {
    id: 'directml',
    supportedPlatforms: ['win32'],
    label: 'DirectML',
    shortLabel: 'DML',
    description: 'ONNX Runtime with DirectML — works on any Windows GPU (AMD/Intel/NVIDIA)',
    requiresEngineBuild: false,
    runsOnnxDirectly: true,
    importPrecisions: ['fp16', 'fp32'],
    supportsShapes: false,
    supportsCustomBuildParams: false,
    vsmlrtBackendAttr: 'ORT_DML',
  },
  {
    id: 'ncnn',
    supportedPlatforms: ['win32', 'linux'],
    label: 'NCNN Vulkan',
    shortLabel: 'NCNN',
    description: 'NCNN with Vulkan — cross-vendor GPU inference for Linux',
    requiresEngineBuild: false,
    runsOnnxDirectly: true,
    importPrecisions: ['fp16', 'fp32'],
    supportsShapes: false,
    supportsCustomBuildParams: false,
    vsmlrtBackendAttr: 'NCNN_VK',
  },
] as const;

export function getBackendDescriptor(id: BackendId): BackendDescriptor {
  const descriptor = BACKENDS.find(b => b.id === id);
  if (!descriptor) {
    throw new Error(`Unknown inference backend: ${id}`);
  }
  return descriptor;
}

export function isBackendId(value: unknown): value is BackendId {
  return typeof value === 'string' && BACKENDS.some(b => b.id === value);
}

/** Whether a backend is supported by the current Vapourkit platform policy. */
export function isBackendSupportedOnPlatform(id: BackendId, platform: string): boolean {
  return getBackendDescriptor(id).supportedPlatforms.includes(platform as BackendPlatform);
}

/** Backends available on a supported platform. Unsupported platforms get none. */
export function getBackendsForPlatform(platform: string): readonly BackendDescriptor[] {
  return BACKENDS.filter(backend => backend.supportedPlatforms.includes(platform as BackendPlatform));
}

/**
 * The safe fallback for persisted or imported backend selections. Linux uses
 * NCNN rather than silently preserving a Windows-only DirectML setting.
 */
export function getDefaultBackendForPlatform(platform: string): BackendId {
  switch (platform) {
    case 'win32':
      return 'tensorrt';
    case 'linux':
      return 'ncnn';
    default:
      throw new Error(`Unsupported platform for inference backends: ${platform}`);
  }
}

/**
 * Normalizes any stored/transported backend value to a valid BackendId.
 * Accepts legacy `useDirectML` booleans from old settings, queue items and
 * workflow files, and falls back to TensorRT for unknown values (matching the
 * pre-refactor default).
 */
export function resolveBackendId(value: unknown): BackendId {
  if (isBackendId(value)) {
    return value;
  }
  if (typeof value === 'boolean') {
    return value ? 'directml' : 'tensorrt';
  }
  return 'tensorrt';
}

/**
 * Normalizes persisted/imported backend values against the platform policy.
 * This is deliberately separate from resolveBackendId so renderer code can
 * migrate legacy values without requiring access to Node's process.platform.
 */
export function normalizeBackendForPlatform(value: unknown, platform: string): BackendId {
  const backend = resolveBackendId(value);
  return isBackendSupportedOnPlatform(backend, platform)
    ? backend
    : getDefaultBackendForPlatform(platform);
}

/**
 * Resolves a per-filter backend selection ('auto' or unset = inherit) against
 * the app-level default backend.
 */
export function resolveFilterBackend(filterBackend: FilterBackend | undefined, defaultBackend: BackendId): BackendId {
  if (filterBackend && filterBackend !== 'auto' && isBackendId(filterBackend)) {
    return filterBackend;
  }
  return defaultBackend;
}
