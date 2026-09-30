// electron/providers/directml.ts
//
// DirectML inference backend. Runs .onnx models directly through vs-mlrt's
// vsort plugin (core.ort.Model with provider="DML") — no build step, works on
// any Windows GPU vendor.

import { PATHS, VS_MLRT_VERSION } from '../constants';
import { getBackendDescriptor } from './descriptors';
import type { InferenceProvider, ModelCallOptions } from './types';
import { resolveOnnxPath } from './onnxPath';

export const directmlProvider: InferenceProvider = {
  descriptor: getBackendDescriptor('directml'),

  resolveModelFile(modelPath: string): string {
    return resolveOnnxPath(modelPath);
  },

  modelCallCode(inputExpr: string, modelFile: string, opts: ModelCallOptions): string {
    const fp16 = opts.useFp32 ? 'False' : 'True';
    return `clip = core.ort.Model(${inputExpr}, network_path="${modelFile.replace(/\\/g, '/')}", num_streams=${opts.numStreams}, provider="DML", device_id=0, fp16=${fp16}, verbosity=4)\n`;
  },

  pipPackages(): string[] {
    return [`vapoursynth-mlrt-ort==${VS_MLRT_VERSION}`];
  },

  pluginHealthPaths(): string[][] {
    // The CPU-only "ort" folder is removed when the CUDA build is present
    // (see applyPluginCompatibilityFixes), so either location counts.
    return [[PATHS.ORT_CUDA_PLUGIN_DLL, PATHS.ORT_PLUGIN_DLL]];
  },
};
