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

  modelCallCode(inputExpr: string, modelFile: string, opts: ModelCallOptions): string {
    return `clip = core.trt.Model(${inputExpr}, engine_path="${modelFile.replace(/\\/g, '/')}", num_streams=${opts.numStreams})\n`;
  },

  pipPackages(): string[] {
    // TensorRT itself (tensorrt-cu13* from pypi.nvidia.com) installs as a
    // dependency of the vs-mlrt TRT wheel.
    return [`vapoursynth-mlrt-trt==${VS_MLRT_VERSION}`];
  },

  pluginHealthPaths(): string[][] {
    return [[PATHS.TRT_PLUGIN_DLL]];
  },

  createBuildJob(): ModelBuildJob {
    return new TrtEngineBuildJob();
  },
};
