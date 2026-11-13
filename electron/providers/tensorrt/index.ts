// electron/providers/tensorrt/index.ts
//
// TensorRT inference backend. Runs pre-built .engine files through vs-mlrt's
// vstrt plugin (core.trt.Model). Models are built from ONNX by the engine
// builder in this folder (see engineBuilder.ts and the bundled
// include/build_trt_engine.py).

import { PATHS, VS_MLRT_VERSION } from '../../constants';
import { getBackendDescriptor } from '../descriptors';
import type { InferenceProvider, ModelCallOptions, ModelBuildJob } from '../types';
import { TrtEngineBuildJob } from './engineBuilder';

export const tensorrtProvider: InferenceProvider = {
  descriptor: getBackendDescriptor('tensorrt'),

  // Filters store the .engine path directly in TensorRT mode.
  resolveModelFile(modelPath: string): string {
    return modelPath;
  },

  // Prepare for the actual stage dimensions and cast using validated engine I/O.
  modelCallCode(inputExpr: string, modelFile: string, opts: ModelCallOptions): string {
    const literal = (value: string) => JSON.stringify(value.replace(/\\/g, '/'));
    return [
      'import vk_model_runtime as _vk_models',
      `clip = _vk_models.load_model(${inputExpr}, ${literal(modelFile)}, streams=${opts.numStreams},`,
      `    builder=${literal(PATHS.APP_DATA + '/build_trt_engine.py')}, python=${literal(PATHS.PYTHON)}, precision="${opts.useFp32 ? 'fp32' : opts.useBf16 ? 'bf16' : 'fp16'}")`,
      '',
    ].join('\n');
  },

  pipPackages(): string[] {
    // TensorRT itself (tensorrt-cu13* from pypi.nvidia.com) installs as a
    // dependency of the vs-mlrt TRT wheel.
    return [
      `vapoursynth-mlrt-trt==${VS_MLRT_VERSION}`,
      // ModelOpt prepares fp32 ONNX models for FP16/BF16 TensorRT builds, then
      // the bundled builder probes TensorRT and learns safe FP32 fallbacks (see
      // include/build_trt_engine.py). The onnx-side packages
      // are named individually rather than pulled via the nvidia-modelopt[onnx]
      // extra, whose closure adds cupy-cuda12x (CUDA 12, against a CUDA 13
      // stack) and onnxruntime-gpu, and pins onnx back to 1.21 — none of which
      // this builder needs at inference time.
      // Capped at the minor releases the builder's indexed cleanup was
      // checked against; it falls back to ModelOpt's own converter on any
      // other release, but the rest of the builder uses ModelOpt's internal
      // module layout too.
      'nvidia-modelopt>=0.45,<0.47',
      'onnx_graphsurgeon',
      'onnxscript',
      'onnxslim',
      'polygraphy',
      'onnxruntime',
      // Imported unconditionally by modelopt.onnx.trt_utils, which AutoCast
      // pulls in through its graph sanitizer — so it is required despite
      // nothing here touching TRT plugin binaries. Only the [onnx] extra
      // declares it, and taking that extra costs cupy and an onnx downgrade.
      'lief',
    ];
  },

  pluginHealthPaths(): string[][] {
    return [[PATHS.TRT_PLUGIN_DLL]];
  },

  createBuildJob(): ModelBuildJob {
    return new TrtEngineBuildJob();
  },
};
