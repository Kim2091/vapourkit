// electron/providers/directml.ts
//
// DirectML inference backend. Runs .onnx models directly through vs-mlrt's
// vsort plugin (core.ort.Model with provider="DML") — no build step, works on
// any Windows GPU vendor.

import * as fs from 'fs-extra';
import { logger } from '../logger';
import { PATHS, VS_MLRT_VERSION } from '../constants';
import { getBackendDescriptor } from './descriptors';
import type { InferenceProvider, ModelCallOptions } from './types';

/**
 * Maps a model path to the ONNX file DirectML should load.
 *
 * Engine files exist under two naming conventions: the same base name as the
 * ONNX (model_fp16.engine) and a doubled precision suffix from custom builds
 * (model_fp16_fp16.engine, where the second suffix is the build precision).
 * A plain .engine → .onnx rename breaks the doubled form, so try both
 * candidates and pick the one that exists on disk.
 */
function resolveOnnxPath(modelPath: string): string {
  if (!/\.engine$/i.test(modelPath)) {
    return modelPath;
  }

  const candidates = [
    modelPath.replace(/\.engine$/i, '.onnx'),
    modelPath.replace(/_fp(16|32)\.engine$/i, '.onnx'),
  ];

  for (const candidate of candidates) {
    if (candidate !== modelPath && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  logger.warn(`No ONNX counterpart found on disk for ${modelPath}; using ${candidates[0]}`);
  return candidates[0];
}

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
