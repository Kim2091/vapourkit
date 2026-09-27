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

  // The clip is prepared as RGBH or RGBS from the model's *build* precision,
  // but vstrt demands the engine's *I/O* type, which comes from the ONNX: an
  // FP16-weight export that keeps FP32 graph inputs (the TSPAN models) builds
  // an engine that wants RGBS, and vstrt refuses RGBH with "bits per sample
  // mismatch" (#12). vstrt checks this when the filter is created, so the
  // script retries once in the other float format instead of failing.
  modelCallCode(inputExpr: string, modelFile: string, opts: ModelCallOptions): string {
    const args = `engine_path="${modelFile.replace(/\\/g, '/')}", num_streams=${opts.numStreams}`;
    return [
      'try:',
      `    clip = core.trt.Model(${inputExpr}, ${args})`,
      'except vs.Error as _vk_trt_error:',
      "    if 'bits per sample mismatch' not in str(_vk_trt_error):",
      '        raise',
      `    _vk_trt_in = ${inputExpr}`,
      '    _vk_trt_in = _vk_trt_in if isinstance(_vk_trt_in, list) else [_vk_trt_in]',
      '    _vk_trt_fmt = vs.RGBS if _vk_trt_in[0].format.bits_per_sample == 16 else vs.RGBH',
      `    clip = core.trt.Model([core.resize.Point(_c, format=_vk_trt_fmt) for _c in _vk_trt_in], ${args})`,
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
      'nvidia-modelopt>=0.45',
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
