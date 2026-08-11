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

export type BackendId = 'tensorrt' | 'directml'; // future: | 'ncnn' | 'openvino'

/** Sentinel for per-filter backend selection: inherit the app-level default. */
export type FilterBackend = BackendId | 'auto';

export interface BackendDescriptor {
  id: BackendId;
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
    label: 'TensorRT',
    shortLabel: 'TRT',
    description: 'NVIDIA TensorRT — fastest on NVIDIA RTX GPUs, models are pre-built into engines',
    requiresEngineBuild: true,
    runsOnnxDirectly: false,
    importPrecisions: ['fp16', 'bf16', 'fp32'],
    supportsShapes: true,
    supportsCustomBuildParams: true,
    // NOT Backend.TRT: vsmlrt's script-side TRT backend builds engines at
    // runtime via trtexec, which the TensorRT pip wheels don't ship. The main
    // upscale step uses pre-built engines through core.trt.Model directly;
    // script filters get the NVIDIA-native ONNX Runtime CUDA backend instead.
    vsmlrtBackendAttr: 'ORT_CUDA',
  },
  {
    id: 'directml',
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
 * Resolves a per-filter backend selection ('auto' or unset = inherit) against
 * the app-level default backend.
 */
export function resolveFilterBackend(filterBackend: FilterBackend | undefined, defaultBackend: BackendId): BackendId {
  if (filterBackend && filterBackend !== 'auto' && isBackendId(filterBackend)) {
    return filterBackend;
  }
  return defaultBackend;
}
