// electron/providers/ncnn.ts
//
// NCNN Vulkan inference. It is Vapourkit's cross-vendor Linux backend and
// loads portable ONNX models directly through vs-mlrt's `core.ncnn` plugin.

import * as fs from 'fs-extra';
import { logger } from '../logger';
import { PATHS, VS_MLRT_NCNN_VERSION } from '../constants';
import { getBackendDescriptor } from './descriptors';
import type { InferenceProvider, ModelCallOptions } from './types';

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
