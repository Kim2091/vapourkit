// electron/providers/tensorrt/engineBuilder.ts
//
// Builds TensorRT engines from ONNX models. Moved out of modelExtractor.ts so
// all TensorRT-specific behavior lives under the tensorrt provider; the
// bundled Python builder (include/build_trt_engine.py) emits trtexec-compatible
// arguments and progress output, which is why the argument vocabulary below is
// trtexec syntax.

import * as path from 'path';
import * as fs from 'fs-extra';
import { logger } from '../../logger';
import { PATHS } from '../../constants';
import { getBundledBasePath, setupVSEnvironment } from '../../utils';
import { createWorkloadSpawnOptions, terminateProcessTree } from '../../processLifecycle';
import type { EngineBuildParams, ModelBuildJob } from '../types';

export class TrtEngineBuildJob implements ModelBuildJob {
  private currentProcess: any = null;
  private isForceStopping: boolean = false;

  /**
   * Copies the bundled TensorRT engine builder script out of the app bundle so
   * the embedded Python can run it (external processes can't read from asar).
   * The TensorRT pip wheels don't ship trtexec, so engines are built with the
   * TensorRT Python API using trtexec-compatible arguments.
   */
  private async ensureEngineBuilderScript(): Promise<string> {
    const bundledScript = path.join(getBundledBasePath(), 'include', 'build_trt_engine.py');
    const targetScript = path.join(PATHS.APP_DATA, 'build_trt_engine.py');
    await fs.copy(bundledScript, targetScript, { overwrite: true });
    return targetScript;
  }

  async buildWithProgress(
    params: EngineBuildParams,
    baseProgress: number,
    progressRange: number,
    progressCallback?: (message: string, progress: number) => void
  ): Promise<void> {
    const onnxFile = path.basename(params.onnxPath);

    await this.build(params, (subProgress) => {
      const totalProgress = baseProgress + Math.round((subProgress / 100) * progressRange);
      progressCallback?.(`Converting ${onnxFile}... ${subProgress}%`, Math.min(totalProgress, 99));
    });
  }

  cancel(): void {
    if (this.currentProcess) {
      logger.model('Cancelling TensorRT engine build process');
      this.killCurrentProcess();
    }
  }

  forceStop(): void {
    logger.model('Force stopping TensorRT engine build process');
    this.isForceStopping = true;
    this.killCurrentProcess();
  }

  private resetForceStop(): void {
    this.isForceStopping = false;
  }

  private isForceStopRequested(): boolean {
    return this.isForceStopping;
  }

  private killCurrentProcess(): void {
    if (this.currentProcess) {
      try {
        terminateProcessTree(this.currentProcess);
        this.currentProcess = null;
      } catch (error) {
        logger.error('Error killing engine build process:', error);
      }
    }
  }

  /**
   * Converts a single ONNX model to a TensorRT engine with custom shapes and
   * precision. Falls back to a shape-less build (and throws
   * STATIC_SHAPE_FALLBACK on success) when the model has inherent static
   * shapes that reject explicit shape arguments.
   */
  async build(
    params: EngineBuildParams,
    progressCallback?: (progress: number) => void
  ): Promise<void> {
    const { onnxPath, enginePath, minShapes, optShapes, maxShapes, useFp32, useBf16, useStaticShape } = params;
    const customBuildParams = params.customBuildParams;

    // Reset force stop flag at the start of a new conversion
    this.resetForceStop();

    // Check if force stop was requested before we even start
    if (this.isForceStopRequested()) {
      throw new Error('Conversion cancelled before starting');
    }

    logger.model(`Converting ONNX model: ${path.basename(onnxPath)}`);
    logger.model(`Precision: ${useFp32 ? 'FP32' : useBf16 ? 'BF16' : 'FP16'}`);
    logger.model(`Shape mode: ${useStaticShape ? 'Static' : 'Dynamic'}`);

    let args: string[];

    // Check if custom trtexec parameters are provided
    if (customBuildParams && customBuildParams.trim()) {
      logger.model('Using custom trtexec parameters');
      logger.model(`Custom params: ${customBuildParams}`);

      // Start with ONNX path - quote it if it contains spaces
      const quotedOnnxPath = onnxPath.includes(' ') ? `"${onnxPath}"` : onnxPath;
      args = [`--onnx=${quotedOnnxPath}`];

      // Replace OUTPUT_PATH placeholder with actual engine path (quoted if needed)
      const quotedEnginePath = enginePath.includes(' ') ? `"${enginePath}"` : enginePath;
      const customParams = customBuildParams.replace(/OUTPUT_PATH/g, quotedEnginePath);

      // Parse custom parameters (split by spaces, but respect quotes)
      const paramMatches = customParams.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
      args.push(...paramMatches.map(p => p.replace(/"/g, '')));
    } else {
      args = this.buildDefaultArgs(onnxPath, enginePath, minShapes, optShapes, maxShapes, useFp32, useBf16, useStaticShape);
    }

    logger.model(`Engine build arguments: ${args.join(' ')}`);

    try {
      await this.runEngineBuildWithProgress(args, PATHS.MODELS, progressCallback);
      logger.model(`Successfully converted ${path.basename(onnxPath)} to ${path.basename(enginePath)}`);
    } catch (error) {
      // If we get a "Static model does not take explicit shapes" error, retry without shape parameters
      const errorMsg = error instanceof Error ? error.message : String(error);
      const hasStaticModelError = errorMsg.includes('Static model does not take explicit shapes') ||
                                   errorMsg.includes('optShapes is being broadcasted');

      if (useStaticShape && hasStaticModelError) {
        logger.model('Model has inherent static shapes, retrying without shape parameters...');

        // Try to extract shape information from error message
        let detectedShape = '';
        const shapeMatch = errorMsg.match(/\[(\d+x\d+x\d+x\d+)\]/);
        if (shapeMatch) {
          detectedShape = shapeMatch[1];
          logger.model(`Detected model shape: ${detectedShape}`);
        }

        const argsWithoutShapes = this.buildDefaultArgs(onnxPath, enginePath, null, null, null, useFp32, useBf16, false);
        logger.model(`Retrying with arguments: ${argsWithoutShapes.join(' ')}`);

        await this.runEngineBuildWithProgress(argsWithoutShapes, PATHS.MODELS, progressCallback);
        logger.model(`Successfully converted ${path.basename(onnxPath)} to ${path.basename(enginePath)}`);

        // Throw a special error to notify about the fallback
        const fallbackError: any = new Error('STATIC_SHAPE_FALLBACK');
        fallbackError.detectedShape = detectedShape;
        throw fallbackError;
      } else {
        // Re-throw if it's a different error
        throw error;
      }
    }
  }

  /**
   * Default trtexec-style argument list. Passing null shapes omits all shape
   * arguments (used by the static-shape fallback retry).
   */
  private buildDefaultArgs(
    onnxPath: string,
    enginePath: string,
    minShapes: string | null,
    optShapes: string | null,
    maxShapes: string | null,
    useFp32: boolean,
    useBf16: boolean | undefined,
    useStaticShape: boolean
  ): string[] {
    // Quote paths that contain spaces
    const quotedOnnxPath = onnxPath.includes(' ') ? `"${onnxPath}"` : onnxPath;
    const quotedEnginePath = enginePath.includes(' ') ? `"${enginePath}"` : enginePath;

    const args = [`--onnx=${quotedOnnxPath}`];

    // For static shapes, only use --optShapes
    // For dynamic shapes, use all three shape parameters
    if (useStaticShape && optShapes) {
      logger.model(`Static shape: ${optShapes}`);
      args.push(`--optShapes=${optShapes}`);
    } else if (minShapes && optShapes && maxShapes) {
      logger.model(`Min shapes: ${minShapes}`);
      logger.model(`Opt shapes: ${optShapes}`);
      logger.model(`Max shapes: ${maxShapes}`);
      args.push(`--minShapes=${minShapes}`);
      args.push(`--optShapes=${optShapes}`);
      args.push(`--maxShapes=${maxShapes}`);
    }

    // Only add precision flags for FP16/BF16, FP32 is the default
    // For BF16: use --bf16 flag but keep fp16 format strings
    if (!useFp32) {
      const precision = 'fp16';
      if (useBf16) {
        args.push('--bf16');
      } else {
        args.push('--fp16');
      }
      args.push(`--inputIOFormats=${precision}:chw`);
      args.push(`--outputIOFormats=${precision}:chw`);
    }

    args.push(
      `--saveEngine=${quotedEnginePath}`,
      '--builderOptimizationLevel=3',
      '--useCudaGraph',
      '--tacticSources=+CUDNN,-CUBLAS,-CUBLAS_LT',
      '--verbose' // Enable verbose output for progress tracking
    );

    return args;
  }

  /**
   * Runs the TensorRT Python engine builder with real-time progress parsing.
   * The builder emits trtexec-compatible progress/phase lines on stdout.
   */
  private async runEngineBuildWithProgress(
    args: string[],
    cwd: string,
    progressCallback?: (progress: number) => void
  ): Promise<void> {
    const builderScript = await this.ensureEngineBuilderScript();

    return new Promise((resolve, reject) => {
      const { spawn } = require('child_process');

      // -u keeps Python's stdout unbuffered so progress lines arrive live
      const proc = spawn(PATHS.PYTHON, ['-u', builderScript, ...args], createWorkloadSpawnOptions({
        cwd,
        shell: false,
        env: setupVSEnvironment(PATHS.PYTHON)
      }));

      // Store the process reference for cancellation
      this.currentProcess = proc;

      let stdout = '';
      let stderr = '';
      let lastProgress = 0;

      if (proc.stdout) {
        proc.stdout.on('data', (data: Buffer) => {
          const output = data.toString();
          stdout += output;

          // Parse progress from trtexec verbose output

          // Pattern 1: Direct percentage
          const percentMatch = output.match(/(\d+)%/);
          if (percentMatch) {
            const progress = parseInt(percentMatch[1]);
            if (progress > lastProgress && progress <= 100) {
              lastProgress = progress;
              progressCallback?.(progress);
              logger.debug(`[engine build progress] ${progress}%`);
            }
          }

          // Pattern 2: Building engine phases
          if (output.includes('Starting inference')) {
            progressCallback?.(95);
            lastProgress = 95;
          } else if (output.includes('Serializing')) {
            progressCallback?.(90);
            lastProgress = 90;
          } else if (output.includes('Building')) {
            if (lastProgress < 30) {
              progressCallback?.(30);
              lastProgress = 30;
            }
          }

          logger.debug(`[engine build stdout] ${output.trim()}`);
        });
      }

      if (proc.stderr) {
        proc.stderr.on('data', (data: Buffer) => {
          const output = data.toString();
          stderr += output;
          logger.debug(`[engine build stderr] ${output.trim()}`);
        });
      }

      proc.on('close', (code: number) => {
        // Clear the process reference
        this.currentProcess = null;

        if (code === 0) {
          progressCallback?.(100);
          logger.debug(`Engine build completed successfully with code ${code}`);
          resolve();
        } else {
          const errorMsg = `Engine build failed with code ${code}: ${stderr || stdout}`;
          logger.error(errorMsg);
          reject(new Error(errorMsg));
        }
      });

      proc.on('error', (error: Error) => {
        // Clear the process reference
        this.currentProcess = null;
        logger.error('Engine build execution error:', error);
        reject(error);
      });
    });
  }
}
