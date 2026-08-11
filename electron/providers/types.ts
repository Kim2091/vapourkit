// electron/providers/types.ts
//
// Electron-side contract each inference backend implements. The shared UI
// metadata lives in descriptors.ts; this interface adds the behavior the main
// process needs: script code generation, model file resolution, install
// packaging, and (for backends that pre-build models) an engine builder.

import type { BackendDescriptor } from './descriptors';

export interface ModelCallOptions {
  /** Parallel inference streams requested by the user. */
  numStreams: number;
  /** True when the model was imported as FP32 (otherwise FP16). */
  useFp32: boolean;
}

export interface EngineBuildParams {
  onnxPath: string;
  enginePath: string;
  minShapes: string;
  optShapes: string;
  maxShapes: string;
  useFp32: boolean;
  useBf16?: boolean;
  useStaticShape: boolean;
  customBuildParams?: string;
}

/**
 * A single cancelable model build job. Only backends with
 * descriptor.requiresEngineBuild provide these (TensorRT today).
 */
export interface ModelBuildJob {
  /**
   * Builds the model, mapping sub-progress into [baseProgress,
   * baseProgress + progressRange] for aggregate progress bars.
   * Throws STATIC_SHAPE_FALLBACK (with detectedShape) when a static-shape
   * build succeeded only after dropping explicit shape arguments.
   */
  buildWithProgress(
    params: EngineBuildParams,
    baseProgress: number,
    progressRange: number,
    progressCallback?: (message: string, progress: number) => void
  ): Promise<void>;
  /** Requests cooperative cancellation of the running build. */
  cancel(): void;
  /** Kills the build process immediately. */
  forceStop(): void;
}

export interface InferenceProvider {
  readonly descriptor: BackendDescriptor;

  /**
   * Maps the model path stored on a filter to the file this backend loads.
   * (DirectML maps .engine paths back to their .onnx source; TensorRT uses
   * the path as-is.)
   */
  resolveModelFile(modelPath: string): string;

  /**
   * Emits the VapourSynth Python statement(s) that run the model on
   * `inputExpr` and assign the result to `clip`. `inputExpr` is either a
   * clip variable or a clip list literal for temporal (VSR) models.
   */
  modelCallCode(inputExpr: string, modelFile: string, opts: ModelCallOptions): string;

  /** pip requirement specs installed with the plugin bundle. */
  pipPackages(): string[];

  /**
   * Plugin locations proving a healthy install. Each inner array lists
   * alternative paths of which at least one must exist.
   */
  pluginHealthPaths(): string[][];

  /** Present only when descriptor.requiresEngineBuild is true. */
  createBuildJob?(): ModelBuildJob;
}
