// electron/providers/tensorrt/engineBuilder.ts
//
// Builds TensorRT engines from ONNX models. The bundled Python builder
// (include/build_trt_engine.py) takes trtexec-compatible arguments, which is
// why the argument vocabulary below is trtexec syntax, and reports progress and
// status through the [vk-build] protocol (engineBuildProtocol.ts).

import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { logger } from '../../logger';
import { PATHS } from '../../constants';
import { setupVSEnvironment } from '../../utils';
import { createWorkloadSpawnOptions, terminateProcessTree } from '../../processLifecycle';
import { ensureEngineBuilderScript } from '../../trtexecShim';
import { parseVkBuildLine } from '../../engineBuildProtocol';
import { appendBounded } from '../../installFlow';
import { LineSplitter } from '../../lineSplitter';
import type { EngineBuildOutcome, EngineBuildParams, ModelBuildJob } from '../types';

// These were present in older generated commands. Keep stale custom command
// strings from reintroducing them when a model is rebuilt.
const REMOVED_TRT_BUILD_ARGS = new Set([
  '--useCudaGraph',
  '--tacticSources=+CUDNN,-CUBLAS,-CUBLAS_LT',
  '--inputIOFormats=fp16:chw',
  '--outputIOFormats=fp16:chw',
]);

/** What the builder prints when a model's shapes are fixed and shape arguments are refused. */
const STATIC_MODEL_ERRORS = ['Static model does not take explicit shapes', 'optShapes is being broadcasted'];

/** A known library warning on stderr that is worth a status line, since the build carries on after it. */
const ONNXSCRIPT_FALLBACK = 'The model version conversion is not supported by the onnxscript version converter';

/** Rejects a build run the user cancelled. */
class BuildCancelledError extends Error {
  constructor() {
    super('MODEL_BUILD_CANCELLED');
  }
}

/** Splits a custom trtexec command into arguments, honouring double quotes. */
export function splitCustomBuildParams(customParams: string): string[] {
  const tokens = customParams.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  return tokens.map(token => token.replace(/"/g, ''));
}

/**
 * The argument list for a build from a custom trtexec command. Arguments are
 * passed to Python as an array, so a path with spaces needs no quoting;
 * OUTPUT_PATH is replaced after the command is split for the same reason.
 */
export function customBuildArgs(onnxPath: string, enginePath: string, customParams: string): string[] {
  return [
    `--onnx=${onnxPath}`,
    ...splitCustomBuildParams(customParams).map(arg => arg.replace(/OUTPUT_PATH/g, enginePath)),
  ];
}

/**
 * Default trtexec-style argument list. Passing null shapes omits all shape
 * arguments (used by the static-shape fallback retry).
 */
export function defaultBuildArgs(
  onnxPath: string,
  enginePath: string,
  minShapes: string | null,
  optShapes: string | null,
  maxShapes: string | null,
  useFp32: boolean,
  useBf16: boolean | undefined,
  useStaticShape: boolean
): string[] {
  const args = [`--onnx=${onnxPath}`];

  // A static shape takes only --optShapes; a dynamic one takes all three.
  if (useStaticShape && optShapes) {
    args.push(`--optShapes=${optShapes}`);
  } else if (minShapes && optShapes && maxShapes) {
    args.push(`--minShapes=${minShapes}`, `--optShapes=${optShapes}`, `--maxShapes=${maxShapes}`);
  }

  // Only FP16/BF16 take a precision flag; FP32 is the default. I/O formats
  // are not passed: strongly typed TensorRT takes them from the ONNX, and the
  // builder ignores them (REMOVED_TRT_BUILD_ARGS strips them from stale
  // custom commands for the same reason).
  if (!useFp32) {
    args.push(useBf16 ? '--bf16' : '--fp16');
  }

  args.push(`--saveEngine=${enginePath}`, '--builderOptimizationLevel=3', '--verbose');
  return args;
}

export class TrtEngineBuildJob implements ModelBuildJob {
  private currentProcess: ChildProcess | null = null;
  private cancelRequested = false;

  async buildWithProgress(
    params: EngineBuildParams,
    baseProgress: number,
    progressRange: number,
    progressCallback?: (message: string, progress: number) => void
  ): Promise<EngineBuildOutcome> {
    const onnxFile = path.basename(params.onnxPath);
    let subProgress = 0;
    const report = (status?: string) => {
      const totalProgress = baseProgress + Math.round((subProgress / 100) * progressRange);
      progressCallback?.(status || `Converting ${onnxFile}... ${subProgress}%`, Math.min(totalProgress, 99));
    };

    return this.build(params, {
      onProgress: percent => {
        subProgress = Math.max(subProgress, percent);
        report();
      },
      onStatus: status => report(status),
    });
  }

  /** Stops the build: kills a running builder, and a build not yet started never starts. */
  cancel(): void {
    logger.model('Cancelling TensorRT engine build');
    this.cancelRequested = true;
    this.killCurrentProcess();
  }

  forceStop(): void {
    logger.model('Force stopping TensorRT engine build');
    this.cancel();
  }

  private killCurrentProcess(): void {
    if (!this.currentProcess) return;
    try {
      terminateProcessTree(this.currentProcess);
    } catch (error) {
      logger.error('Error killing engine build process:', error);
    }
    this.currentProcess = null;
  }

  /**
   * Converts a single ONNX model to a TensorRT engine with custom shapes and
   * precision. A model with inherent static shapes refuses explicit shape
   * arguments; that build is retried without them, and the outcome says so.
   */
  async build(
    params: EngineBuildParams,
    callbacks: { onProgress?: (percent: number) => void; onStatus?: (status: string) => void } = {}
  ): Promise<EngineBuildOutcome> {
    const { onnxPath, enginePath, minShapes, optShapes, maxShapes, useFp32, useBf16, useStaticShape } = params;
    const customBuildParams = params.customBuildParams?.trim();

    if (this.cancelRequested) return { kind: 'cancelled' };

    logger.model(`Converting ONNX model: ${path.basename(onnxPath)}`);
    logger.model(`Precision: ${useFp32 ? 'FP32' : useBf16 ? 'BF16' : 'FP16'}`);
    logger.model(`Shape mode: ${useStaticShape ? 'Static' : 'Dynamic'}`);

    let args: string[];
    if (customBuildParams) {
      logger.model(`Using custom trtexec parameters: ${customBuildParams}`);
      args = customBuildArgs(onnxPath, enginePath, customBuildParams);
    } else {
      args = defaultBuildArgs(onnxPath, enginePath, minShapes, optShapes, maxShapes, useFp32, useBf16, useStaticShape);
    }
    args = args.filter(arg => !REMOVED_TRT_BUILD_ARGS.has(arg));

    try {
      await this.runBuilder(args, callbacks);
      logger.model(`Successfully converted ${path.basename(onnxPath)} to ${path.basename(enginePath)}`);
      return { kind: 'built' };
    } catch (error) {
      if (error instanceof BuildCancelledError) return { kind: 'cancelled' };
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (!useStaticShape || !STATIC_MODEL_ERRORS.some(text => errorMsg.includes(text))) {
        throw error;
      }
      if (this.cancelRequested) return { kind: 'cancelled' };

      logger.model('Model has inherent static shapes, retrying without shape parameters...');
      const detectedShape = errorMsg.match(/\[(\d+x\d+x\d+x\d+)\]/)?.[1] ?? '';
      if (detectedShape) {
        logger.model(`Detected model shape: ${detectedShape}`);
      }

      const argsWithoutShapes = defaultBuildArgs(onnxPath, enginePath, null, null, null, useFp32, useBf16, false);
      try {
        await this.runBuilder(argsWithoutShapes, callbacks);
      } catch (retryError) {
        if (retryError instanceof BuildCancelledError) return { kind: 'cancelled' };
        throw retryError;
      }
      logger.model(`Successfully converted ${path.basename(onnxPath)} to ${path.basename(enginePath)}`);
      return { kind: 'built', staticShapeFallback: { detectedShape } };
    }
  }

  /** Runs the Python engine builder, reporting its [vk-build] progress and status lines. */
  private async runBuilder(
    args: string[],
    callbacks: { onProgress?: (percent: number) => void; onStatus?: (status: string) => void },
  ): Promise<void> {
    logger.model(`Engine build arguments: ${args.join(' ')}`);
    const builderScript = await ensureEngineBuilderScript();
    if (this.cancelRequested) throw new BuildCancelledError();

    return new Promise((resolve, reject) => {
      // -u keeps Python's stdout unbuffered so progress lines arrive live.
      const proc = spawn(PATHS.PYTHON, ['-u', builderScript, ...args], createWorkloadSpawnOptions({
        cwd: PATHS.MODELS,
        shell: false,
        windowsHide: true,
        env: setupVSEnvironment(PATHS.PYTHON),
      }));
      this.currentProcess = proc;

      let stdout = '';
      let stderr = '';

      const onLine = (line: string) => {
        const event = parseVkBuildLine(line);
        if (event?.type === 'progress') {
          callbacks.onProgress?.(event.percent);
        } else if (event?.type === 'status') {
          callbacks.onStatus?.(event.text);
        } else if (line.includes(ONNXSCRIPT_FALLBACK)) {
          callbacks.onStatus?.('ONNX opset conversion fallback reported; continuing...');
        }
      };
      const outLines = new LineSplitter(line => {
        logger.debug(`[engine build stdout] ${line}`);
        onLine(line);
      });
      const errLines = new LineSplitter(line => {
        logger.debug(`[engine build stderr] ${line}`);
        onLine(line);
      });

      proc.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout = appendBounded(stdout, text);
        outLines.push(text);
      });
      proc.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        stderr = appendBounded(stderr, text);
        errLines.push(text);
      });

      proc.on('close', (code: number | null) => {
        outLines.flush();
        errLines.flush();
        this.currentProcess = null;

        if (code === 0) {
          callbacks.onProgress?.(100);
          resolve();
        } else if (this.cancelRequested) {
          // taskkill commonly reports exit code 1 on Windows. Do not turn a
          // user cancellation into a misleading engine-build failure.
          reject(new BuildCancelledError());
        } else {
          // Warnings from ONNX/onnxscript are written to stderr even when the
          // build is healthy. A nonzero exit code is still fatal, but retain
          // both streams so a warning cannot hide the actual exception.
          const output = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n');
          const errorMsg = `Engine build failed with code ${code}: ${output || 'No diagnostic output was produced'}`;
          logger.error(errorMsg);
          reject(new Error(errorMsg));
        }
      });

      proc.on('error', (error: Error) => {
        this.currentProcess = null;
        logger.error('Engine build execution error:', error);
        reject(error);
      });
    });
  }
}
