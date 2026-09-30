// electron/providers/ncnn.ts
//
// NCNN Vulkan inference. It is Vapourkit's cross-vendor Linux backend and
// loads portable ONNX models directly through vs-mlrt's `core.ncnn` plugin.

import { PATHS, VS_MLRT_NCNN_VERSION } from '../constants';
import { getBackendDescriptor } from './descriptors';
import type { InferenceProvider, ModelCallOptions } from './types';
import { resolveOnnxPath } from './onnxPath';

export const ncnnProvider: InferenceProvider = {
  descriptor: getBackendDescriptor('ncnn'),

  resolveModelFile(modelPath: string): string {
    return resolveOnnxPath(modelPath);
  },

  modelCallCode(inputExpr: string, modelFile: string, opts: ModelCallOptions): string {
    const fp16 = opts.useFp32 ? 'False' : 'True';
    return `clip = core.ncnn.Model(${inputExpr}, network_path="${modelFile.replace(/\\/g, '/')}", num_streams=${opts.numStreams}, device_id=0, fp16=${fp16})\n`;
  },

  pipPackages(): string[] {
    return [`vapoursynth-mlrt-ncnn==${VS_MLRT_NCNN_VERSION}`];
  },

  pluginHealthPaths(): string[][] {
    return [[PATHS.NCNN_PLUGIN_DLL]];
  },
};
