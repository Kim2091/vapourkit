// electron/modelExtractor.ts
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs-extra';
import { logger } from './logger';
import { PATHS } from './constants';

export class ModelExtractor {
  private bundledModelsPath: string;
  private currentTrtexecProcess: any = null;

  constructor() {
    // Get bundled models path
    const appPath = app.getAppPath();
    if (process.env.NODE_ENV === 'development') {
      // In development, models are in the project root under include/
      this.bundledModelsPath = path.join(appPath, 'include', 'models');
    } else {
      // In production, models are unpacked from ASAR
      if (appPath.includes('.asar')) {
        const asarUnpackedPath = appPath.replace('app.asar', 'app.asar.unpacked');
        this.bundledModelsPath = path.join(asarUnpackedPath, 'include', 'models');
      } else {
        this.bundledModelsPath = path.join(appPath, 'include', 'models');
      }
    }
    
    logger.model(`Initialized ModelExtractor`);
    logger.model(`Bundled models path: ${this.bundledModelsPath}`);
    logger.model(`Target models path: ${PATHS.MODELS}`);
    logger.model(`trtexec path: ${PATHS.TRTEXEC}`);
  }

  /**
   * Checks if models need to be extracted to AppData
   */
  async needsExtraction(): Promise<boolean> {
    logger.model('Checking if models need extraction');
    
    // Check if models directory exists in AppData
    if (!await fs.pathExists(PATHS.MODELS)) {
      logger.model('Models directory does not exist in AppData, extraction needed');
      return true;
    }

    // Check if bundled models exist
    if (!await fs.pathExists(this.bundledModelsPath)) {
      logger.warn(`Bundled models not found at: ${this.bundledModelsPath}`);
      return false;
    }

    // Get list of bundled ONNX models
    const bundledFiles = await fs.readdir(this.bundledModelsPath);
    const bundledModels = bundledFiles.filter(f => f.endsWith('.onnx'));
    logger.model(`Found ${bundledModels.length} bundled ONNX model(s): ${bundledModels.join(', ')}`);

    // Check if all ONNX models exist in AppData
    for (const model of bundledModels) {
      const targetPath = path.join(PATHS.MODELS, model);
      if (!await fs.pathExists(targetPath)) {
        logger.model(`ONNX model ${model} not found in AppData, extraction needed`);
        return true;
      }
    }

    logger.model('All ONNX models already extracted');
    return false;
  }

  /**
   * Checks if ONNX models need to be converted to TensorRT engines
   * NOTE: This is no longer used during initial setup - models are initialized on-demand
   */
  async needsConversion(): Promise<boolean> {
    logger.model('Checking if ONNX models need conversion to TensorRT engines');
    
    if (!await fs.pathExists(PATHS.MODELS)) {
      logger.model('Models directory does not exist, conversion needed');
      return true;
    }

    // Get list of ONNX models in AppData
    const files = await fs.readdir(PATHS.MODELS);
    const onnxModels = files.filter(f => f.endsWith('.onnx'));
    
    if (onnxModels.length === 0) {
      logger.model('No ONNX models found, conversion not needed');
      return false;
    }

    // Check if corresponding .engine files exist for each ONNX model
    for (const onnxFile of onnxModels) {
      const engineFile = onnxFile.replace('.onnx', '.engine');
      const enginePath = path.join(PATHS.MODELS, engineFile);
      
      if (!await fs.pathExists(enginePath)) {
        logger.model(`Engine file ${engineFile} not found, conversion needed`);
        return true;
      }
    }

    logger.model('All ONNX models already converted to engines');
    return false;
  }

  /**
   * Extracts bundled ONNX models to AppData
   */
  async extractModels(progressCallback?: (message: string, progress: number) => void): Promise<void> {
    logger.separator();
    logger.model('Starting ONNX model extraction');
    
    try {
      // Ensure models directory exists in AppData
      await fs.ensureDir(PATHS.MODELS);

      if (!await fs.pathExists(this.bundledModelsPath)) {
        const error = `Bundled models not found at: ${this.bundledModelsPath}`;
        logger.error(error);
        throw new Error(error);
      }

      progressCallback?.('Checking bundled ONNX models...', 0);

      // Get list of ONNX model files
      const files = await fs.readdir(this.bundledModelsPath);
      const modelFiles = files.filter(f => f.endsWith('.onnx'));

      if (modelFiles.length === 0) {
        logger.warn('No ONNX model files found in bundled models directory');
        return;
      }

      logger.model(`Found ${modelFiles.length} ONNX model(s) to extract: ${modelFiles.join(', ')}`);

      // Copy each ONNX model file
      for (let i = 0; i < modelFiles.length; i++) {
        const modelFile = modelFiles[i];
        const sourcePath = path.join(this.bundledModelsPath, modelFile);
        const targetPath = path.join(PATHS.MODELS, modelFile);

        progressCallback?.(`Extracting ${modelFile}...`, Math.round(((i + 1) / modelFiles.length) * 100));

        // Check if file already exists and has the same size
        if (await fs.pathExists(targetPath)) {
          const sourceStats = await fs.stat(sourcePath);
          const targetStats = await fs.stat(targetPath);
          
          if (sourceStats.size === targetStats.size) {
            logger.model(`ONNX model ${modelFile} already exists with same size (${sourceStats.size} bytes), skipping`);
            continue;
          }
        }

        logger.model(`Copying ${modelFile} (${(await fs.stat(sourcePath)).size} bytes) to AppData...`);
        await fs.copy(sourcePath, targetPath, { overwrite: true });
        logger.model(`Successfully copied ${modelFile}`);
      }

      progressCallback?.('ONNX models extracted successfully', 100);
      logger.model('All ONNX models extracted to AppData successfully');
      logger.separator();
    } catch (error) {
      logger.error('Error extracting ONNX models:', error);
      throw error;
    }
  }

  /**
   * Converts ONNX models to TensorRT engines using trtexec
   * NOTE: This is no longer called during initial setup
   */
  async convertModelsToEngine(progressCallback?: (message: string, progress: number) => void): Promise<void> {
    logger.separator();
    logger.model('Starting ONNX to TensorRT engine conversion');
    
    try {
      // Check if trtexec exists
      if (!await fs.pathExists(PATHS.TRTEXEC)) {
        const error = `trtexec not found at: ${PATHS.TRTEXEC}`;
        logger.error(error);
        throw new Error(error);
      }

      // Get list of ONNX models
      const files = await fs.readdir(PATHS.MODELS);
      const onnxFiles = files.filter(f => f.endsWith('.onnx'));

      if (onnxFiles.length === 0) {
        logger.warn('No ONNX models found to convert');
        return;
      }

      logger.model(`Found ${onnxFiles.length} ONNX model(s) to convert: ${onnxFiles.join(', ')}`);

      // Convert each ONNX model
      for (let i = 0; i < onnxFiles.length; i++) {
        const onnxFile = onnxFiles[i];
        const onnxPath = path.join(PATHS.MODELS, onnxFile);
        const engineFile = onnxFile.replace('.onnx', '.engine');
        const enginePath = path.join(PATHS.MODELS, engineFile);

        // Skip if engine already exists
        if (await fs.pathExists(enginePath)) {
          logger.model(`Engine ${engineFile} already exists, skipping conversion`);
          progressCallback?.(`${engineFile} already exists`, Math.round(((i + 1) / onnxFiles.length) * 100));
          continue;
        }

        const baseProgress = Math.round((i / onnxFiles.length) * 100);
        const progressRange = Math.round(100 / onnxFiles.length);
        
        progressCallback?.(`Converting ${onnxFile} to TensorRT engine (${i + 1}/${onnxFiles.length})...`, baseProgress);
        logger.model(`Converting ${onnxFile} to ${engineFile}`);

        // Use default shapes for bundled models (FP16 by default)
        await this.convertToEngineWithProgress(
          onnxPath,
          enginePath,
          'input:1x15x240x240',
          'input:1x15x720x1280',
          'input:1x15x1080x1920',
          false, // useFp32
          false, // useStaticShape - use dynamic for bundled models
          baseProgress,
          progressRange,
          progressCallback
        );

        logger.model(`Successfully converted ${onnxFile} to ${engineFile}`);
      }

      progressCallback?.('All models converted to TensorRT engines', 100);
      logger.model('All ONNX models converted successfully');
      logger.separator();
    } catch (error) {
      logger.error('Error converting ONNX models to engines:', error);
      throw error;
    }
  }

  /**
   * Converts a single ONNX model with progress reporting that maps sub-progress to an overall range
   * This is used by both setup and custom model import to avoid code duplication
   */
  async convertToEngineWithProgress(
    onnxPath: string,
    enginePath: string,
    minShapes: string,
    optShapes: string,
    maxShapes: string,
    useFp32: boolean,
    useStaticShape: boolean,
    baseProgress: number,
    progressRange: number,
    progressCallback?: (message: string, progress: number) => void,
    customTrtexecParams?: string
  ): Promise<void> {
    const onnxFile = path.basename(onnxPath);
    
    await this.convertToEngine(
      onnxPath,
      enginePath,
      minShapes,
      optShapes,
      maxShapes,
      useFp32,
      useStaticShape,
      (subProgress) => {
        const totalProgress = baseProgress + Math.round((subProgress / 100) * progressRange);
        progressCallback?.(`Converting ${onnxFile}... ${subProgress}%`, Math.min(totalProgress, 99));
      },
      customTrtexecParams
    );
  }


  /**
   * Cancels the current trtexec conversion process if running
   */
  cancelConversion(): void {
    if (this.currentTrtexecProcess) {
      logger.model('Canceling trtexec conversion process');
      try {
        // On Windows, we need to kill the entire process tree
        if (process.platform === 'win32') {
          const { exec } = require('child_process');
          exec(`taskkill /pid ${this.currentTrtexecProcess.pid} /T /F`, (error: any) => {
            if (error) {
              logger.error('Error killing trtexec process tree:', error);
            } else {
              logger.model('trtexec process tree terminated');
            }
          });
        } else {
          // On Unix-like systems, send SIGTERM first, then SIGKILL if needed
          this.currentTrtexecProcess.kill('SIGTERM');
          setTimeout(() => {
            if (this.currentTrtexecProcess && !this.currentTrtexecProcess.killed) {
              this.currentTrtexecProcess.kill('SIGKILL');
            }
          }, 3000);
        }
        this.currentTrtexecProcess = null;
      } catch (error) {
        logger.error('Error canceling trtexec process:', error);
      }
    }
  }


  /**
   * Converts a single ONNX model to TensorRT engine with custom shapes and precision
   * This is the unified conversion method used by both setup and custom imports
   */
  async convertToEngine(
    onnxPath: string, 
    enginePath: string,
    minShapes: string,
    optShapes: string,
    maxShapes: string,
    useFp32: boolean,
    useStaticShape: boolean,
    progressCallback?: (progress: number) => void,
    customTrtexecParams?: string
  ): Promise<void> {
    logger.model(`Converting ONNX model: ${path.basename(onnxPath)}`);
    logger.model(`Precision: ${useFp32 ? 'FP32' : 'FP16'}`);
    logger.model(`Shape mode: ${useStaticShape ? 'Static' : 'Dynamic'}`);
    
    let args: string[];
    
    // Check if custom trtexec parameters are provided
    if (customTrtexecParams && customTrtexecParams.trim()) {
      logger.model('Using custom trtexec parameters');
      logger.model(`Custom params: ${customTrtexecParams}`);
      
      // Start with ONNX path - quote it if it contains spaces
      const quotedOnnxPath = onnxPath.includes(' ') ? `"${onnxPath}` : onnxPath;
      args = [`--onnx=${quotedOnnxPath}`];
      
      // Replace OUTPUT_PATH placeholder with actual engine path (quoted if needed)
      const quotedEnginePath = enginePath.includes(' ') ? `"${enginePath}"` : enginePath;
      const customParams = customTrtexecParams.replace(/OUTPUT_PATH/g, quotedEnginePath);
      
      // Parse custom parameters (split by spaces, but respect quotes)
      const paramMatches = customParams.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
      args.push(...paramMatches.map(p => p.replace(/"/g, '')));
      
      // Always add --verbose for progress tracking
      args.push('--verbose');
    } else {
      // Use default parameter building logic
      // Quote paths that contain spaces
      const quotedOnnxPath = onnxPath.includes(' ') ? `"${onnxPath}"` : onnxPath;
      const quotedEnginePath = enginePath.includes(' ') ? `"${enginePath}"` : enginePath;
      
      args = [
        `--onnx=${quotedOnnxPath}`,
      ];
      
      // For static shapes, only use --optShapes
      // For dynamic shapes, use all three shape parameters
      if (useStaticShape) {
        logger.model(`Static shape: ${optShapes}`);
        args.push(`--optShapes=${optShapes}`);
      } else {
        logger.model(`Min shapes: ${minShapes}`);
        logger.model(`Opt shapes: ${optShapes}`);
        logger.model(`Max shapes: ${maxShapes}`);
        args.push(`--minShapes=${minShapes}`);
        args.push(`--optShapes=${optShapes}`);
        args.push(`--maxShapes=${maxShapes}`);
      }
      
      // Only add precision flags for FP16, FP32 is the default
      if (!useFp32) {
        const precision = 'fp16';
        args.push('--fp16');
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
    }

    logger.model(`trtexec command: ${PATHS.TRTEXEC} ${args.join(' ')}`);

    try {
      await this.runTrtexecWithProgress(PATHS.TRTEXEC, args, PATHS.MODELS, progressCallback);
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
        
        // Rebuild args without shape parameters
        const quotedOnnxPath = onnxPath.includes(' ') ? `"${onnxPath}"` : onnxPath;
        const quotedEnginePath = enginePath.includes(' ') ? `"${enginePath}"` : enginePath;
        
        const argsWithoutShapes = [
          `--onnx=${quotedOnnxPath}`,
        ];
        
        if (!useFp32) {
          const precision = 'fp16';
          argsWithoutShapes.push('--fp16');
          argsWithoutShapes.push(`--inputIOFormats=${precision}:chw`);
          argsWithoutShapes.push(`--outputIOFormats=${precision}:chw`);
        }
        
        argsWithoutShapes.push(
          `--saveEngine=${quotedEnginePath}`,
          '--builderOptimizationLevel=3',
          '--useCudaGraph',
          '--tacticSources=+CUDNN,-CUBLAS,-CUBLAS_LT',
          '--verbose'
        );
        
        logger.model(`Retrying with command: ${PATHS.TRTEXEC} ${argsWithoutShapes.join(' ')}`);
        
        try {
          await this.runTrtexecWithProgress(PATHS.TRTEXEC, argsWithoutShapes, PATHS.MODELS, progressCallback);
          logger.model(`Successfully converted ${path.basename(onnxPath)} to ${path.basename(enginePath)}`);
          
          // Throw a special error to notify about the fallback
          const fallbackError: any = new Error('STATIC_SHAPE_FALLBACK');
          fallbackError.detectedShape = detectedShape;
          throw fallbackError;
        } catch (retryError: any) {
          // If it's our fallback notification, re-throw it
          if (retryError.message === 'STATIC_SHAPE_FALLBACK') {
            throw retryError;
          }
          // Otherwise throw the retry error
          throw retryError;
        }
      } else {
        // Re-throw if it's a different error
        throw error;
      }
    }
  }

  /**
   * Runs trtexec with real-time progress parsing
   */
  private async runTrtexecWithProgress(
    command: string,
    args: string[],
    cwd: string,
    progressCallback?: (progress: number) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const { spawn } = require('child_process');
      
      // Don't quote the command or args - spawn handles paths correctly without shell
      const proc = spawn(command, args, {
        cwd,
        shell: false, // Changed from true to false for proper argument handling
        env: process.env
      });

      // Store the process reference for cancellation
      this.currentTrtexecProcess = proc;

      let stdout = '';
      let stderr = '';
      let lastProgress = 0;

      if (proc.stdout) {
        proc.stdout.on('data', (data: Buffer) => {
          const output = data.toString();
          stdout += output;
          
          // Parse progress from trtexec verbose output
          // Look for patterns like:
          // - "Building engine: X%"
          // - "[X/Y] Building..."
          // - "Optimization pass X of Y"
          
          // Pattern 1: Direct percentage
          const percentMatch = output.match(/(\d+)%/);
          if (percentMatch) {
            const progress = parseInt(percentMatch[1]);
            if (progress > lastProgress && progress <= 100) {
              lastProgress = progress;
              progressCallback?.(progress);
              logger.debug(`[trtexec progress] ${progress}%`);
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
          
          logger.debug(`[trtexec stdout] ${output.trim()}`);
        });
      }

      if (proc.stderr) {
        proc.stderr.on('data', (data: Buffer) => {
          const output = data.toString();
          stderr += output;
          logger.debug(`[trtexec stderr] ${output.trim()}`);
        });
      }

      proc.on('close', (code: number) => {
        // Clear the process reference
        this.currentTrtexecProcess = null;
        
        if (code === 0) {
          progressCallback?.(100);
          logger.debug(`trtexec completed successfully with code ${code}`);
          resolve();
        } else {
          const errorMsg = `trtexec failed with code ${code}: ${stderr || stdout}`;
          logger.error(errorMsg);
          reject(new Error(errorMsg));
        }
      });

      proc.on('error', (error: Error) => {
        // Clear the process reference
        this.currentTrtexecProcess = null;
        logger.error('trtexec execution error:', error);
        reject(error);
      });
    });
  }

  /**
   * Gets the AppData models path
   */
  getModelsPath(): string {
    return PATHS.MODELS;
  }

  /**
   * Gets the bundled models path
   */
  getBundledModelsPath(): string {
    return this.bundledModelsPath;
  }
}