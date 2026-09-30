// electron/providers/migraphx.ts
//
// AMD MIGraphX inference through vs-mlrt's vsmigx plugin (core.migx.Model).
//
// vsmigx runs a pre-compiled .mxr program, and a program is compiled for one
// exact input size. So rather than an import-time build (TensorRT's model),
// the generated script calls vk_migx_model() — defined by the backend helper in
// scriptGenerator.ts — which compiles the ONNX at the clip's resolution with
// vsmlrt's migraphx_driver() on first use and reuses the cached program after.
//
// Plugin source differs by platform: Linux takes the pip wheel (which links the
// system ROCm install); Windows has no wheel, so migxRuntimeManager.ts installs
// the GitHub release build and its HIP runtime.

import { PATHS, VS_MLRT_MIGX_VERSION } from '../constants';
import { inspectOnnxGraph } from '../onnxGraphInspector';
import { getBackendDescriptor } from './descriptors';
import { resolveOnnxPath } from './onnxPath';
import type { InferenceProvider, ModelCallOptions } from './types';

function pyString(value: string): string {
  return JSON.stringify(value);
}

export const migraphxProvider: InferenceProvider = {
  descriptor: getBackendDescriptor('migraphx'),

  resolveModelFile(modelPath: string): string {
    return resolveOnnxPath(modelPath);
  },

  modelCallCode(inputExpr: string, modelFile: string, opts: ModelCallOptions): string {
    const networkPath = modelFile.replace(/\\/g, '/');
    // migraphx-driver pins the input by name (--input-dim @<name>), and vsmigx
    // only accepts a 4-D, batch-1 input: say so up front rather than letting
    // the driver fail minutes into a compile.
    const graph = inspectOnnxGraph(modelFile);
    const rank = graph?.inputShape?.length;
    if (rank !== undefined && rank !== 4) {
      const message = `MIGraphX only runs models with a 4-D input (N, C, H, W); ` +
        `${networkPath.split('/').pop()} has a ${rank}-D input. Use DirectML or NCNN for this model.`;
      return `raise vs.Error(${pyString(message)})\n`;
    }
    const inputName = graph?.inputName ?? 'input';
    const fp16 = opts.useFp32 ? 'False' : 'True';
    return `clip = vk_migx_model(${inputExpr}, ${pyString(networkPath)}, input_name=${pyString(inputName)}, fp16=${fp16}, num_streams=${opts.numStreams})\n`;
  },

  pipPackages(platform: NodeJS.Platform = process.platform): string[] {
    // The wheel only exists for Linux x86_64. Decided here rather than with a
    // pip environment marker: the install check expects every spec listed, so a
    // spec pip skipped would read as missing forever.
    return platform === 'linux' && process.arch === 'x64'
      ? [`vapoursynth-mlrt-migx==${VS_MLRT_MIGX_VERSION}`]
      : [];
  },

  pluginHealthPaths(): string[][] {
    return [[PATHS.MIGX_PLUGIN_DLL]];
  },
};
