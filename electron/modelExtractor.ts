// electron/modelExtractor.ts
//
// Extracts the bundled ONNX models into the user's data folder. Backend-
// specific model building (e.g. TensorRT engines) lives with the matching
// inference provider under electron/providers/.
import * as path from 'path';
import * as fs from 'fs-extra';
import { logger } from './logger';
import { PATHS } from './constants';
import { getBundledBasePath } from './utils';

export class ModelExtractor {
  private bundledModelsPath: string;

  constructor() {
    this.bundledModelsPath = path.join(getBundledBasePath(), 'include', 'models');

    logger.model(`Initialized ModelExtractor`);
    logger.model(`Bundled models path: ${this.bundledModelsPath}`);
    logger.model(`Target models path: ${PATHS.MODELS}`);
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
