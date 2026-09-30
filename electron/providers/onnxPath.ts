// electron/providers/onnxPath.ts
//
// Shared by the backends that load ONNX directly (DirectML, NCNN, MIGraphX):
// a filter saved while TensorRT was selected stores an .engine path, and these
// backends need the ONNX it was built from.

import * as fs from 'fs-extra';
import { logger } from '../logger';

/**
 * Maps a model path to the ONNX file to load.
 *
 * Engine files exist under two naming conventions: the same base name as the
 * ONNX (model_fp16.engine) and a doubled precision suffix from custom builds
 * (model_fp16_fp16.engine, where the second suffix is the build precision).
 * A plain .engine → .onnx rename breaks the doubled form, so try both
 * candidates and pick the one that exists on disk.
 */
export function resolveOnnxPath(modelPath: string): string {
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
