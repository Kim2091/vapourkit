import { ipcMain, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs-extra';
import { logger } from './logger';
import { PATHS } from './constants';
import { configManager } from './configManager';
import { withLogSeparator } from './utils';
import { sendModelImportProgress } from './ipcUtilities';
import { handleValidated } from './ipcValidation';
import { z } from 'zod';
import { resolveProvider } from './providers/registry';
import { precisionOf, withPrecisionSuffix } from './modelPrecision';
import type { ModelBuildJob } from './providers/types';

// Module-level build job reference for cancellation support
let activeBuildJob: ModelBuildJob | null = null;

/**
 * Cancels any active model build/import operation
 */
export function cancelActiveModelOperation(): void {
  if (activeBuildJob) {
    activeBuildJob.cancel();
    activeBuildJob = null;
  }
}

/**
 * Registers all model-related IPC handlers
 */
export function registerModelHandlers(mainWindow: BrowserWindow | null) {
  ipcMain.handle('get-available-models', async () => {
    logger.info('Getting available models');
    try {
      await fs.ensureDir(PATHS.MODELS);
      
      const files = await fs.readdir(PATHS.MODELS);
      const engineFiles = files.filter(f => f.endsWith('.engine'));
      const onnxFiles = files.filter(f => f.endsWith('.onnx'));
      
      // Build a set of ONNX basenames that have corresponding engines
      // Engine naming: modelname_fp16.onnx -> modelname_fp16_fp16.engine
      const onnxBasenamesWithEngines = new Set<string>();
      for (const engineFile of engineFiles) {
        const engineBaseName = path.basename(engineFile, '.engine');
        // Engine files have doubled precision suffix, e.g., model_fp16_fp16.engine
        // Try to find the corresponding ONNX basename
        const match = engineBaseName.match(/^(.+)_(fp16|fp32)$/i);
        if (match) {
          onnxBasenamesWithEngines.add(match[1]);
        }
      }

      // Include both .engine files (for TensorRT) and .onnx files (for DirectML)
      const models = [
        ...engineFiles.map(file => {
          const metadataId = path.basename(file, '.engine');
          const id = `${metadataId}::engine`;
          const metadata = configManager.getModelMetadata(metadataId);
          return {
            id,
            metadataId,
            name: metadataId, // Clean: just the filename without extension
            path: path.join(PATHS.MODELS, file),
            precision: metadata?.useFp32 ? 'FP32' : 'FP16',
            backend: 'tensorrt' as const,
            modelType: metadata?.modelType || 'image',
            displayTag: metadata?.displayTag,
            description: metadata?.description,
            category: metadata?.category
          };
        }),
        ...onnxFiles.map(file => {
          const metadataId = path.basename(file, '.onnx');
          const id = `${metadataId}::onnx`;
          const metadata = configManager.getModelMetadata(metadataId);
          const hasEngine = onnxBasenamesWithEngines.has(metadataId);
          
          return {
            id,
            metadataId,
            name: metadataId, // Clean: just the filename without extension
            path: path.join(PATHS.MODELS, file),
            precision: metadata?.useFp32 ? 'FP32' : 'FP16',
            backend: 'onnx' as const,
            hasEngine,
            modelType: metadata?.modelType || 'image',
            displayTag: metadata?.displayTag,
            description: metadata?.description,
            category: metadata?.category
          };
        })
      ];
      
      logger.info(`Found ${models.length} model(s): ${models.map(m => m.id).join(', ')}`);
      return models;
    } catch (error) {
      logger.error('Error getting available models:', error);
      throw error;
    }
  });

  ipcMain.handle('get-uninitialized-models', async () => {
    logger.info('Getting uninitialized models');
    try {
      await fs.ensureDir(PATHS.MODELS);
      
      const files = await fs.readdir(PATHS.MODELS);
      const onnxFiles = files.filter(f => f.endsWith('.onnx'));
      const engineFiles = files.filter(f => f.endsWith('.engine'));
      
      // Find ONNX models without corresponding engine files
      const uninitializedModels = onnxFiles
        .filter(onnxFile => {
          const engineFile = onnxFile.replace('.onnx', '.engine');
          return !engineFiles.includes(engineFile);
        })
        .map(file => {
          const modelName = path.basename(file, '.onnx');
          const metadata = configManager.getModelMetadata(modelName);
          
          return {
            id: modelName,
            name: modelName,
            onnxPath: path.join(PATHS.MODELS, file),
            modelType: metadata?.modelType,
            displayTag: metadata?.displayTag
          };
        });
      
      logger.info(`Found ${uninitializedModels.length} uninitialized model(s): ${uninitializedModels.map(m => m.name).join(', ')}`);
      return uninitializedModels;
    } catch (error) {
      logger.error('Error getting uninitialized models:', error);
      throw error;
    }
  });

  ipcMain.handle('initialize-model', async (event, params: {
    onnxPath: string;
    modelName: string;
    minShapes: string;
    optShapes: string;
    maxShapes: string;
    useFp32: boolean;
    useBf16?: boolean;
    modelType?: string;
    temporalFrames?: number;
    displayTag?: string;
    useStaticShape?: boolean;
    useCustomTrtexecParams?: boolean;
    customTrtexecParams?: string;
  }) => {
    return await withLogSeparator(async () => {
      logger.model('Starting model initialization');
      logger.model(`ONNX path: ${params.onnxPath}`);
      logger.model(`Model name: ${params.modelName}`);
      logger.model(`Precision: ${params.useFp32 ? 'FP32' : params.useBf16 ? 'BF16' : 'FP16'}`);
      logger.model(`Model type: ${params.modelType || 'image'}`);
      
      try {
        // Model initialization is an engine build — only backends that
        // pre-build models offer it (TensorRT today). resolveProvider maps an
        // unset backend to the TensorRT default.
        const provider = resolveProvider(undefined);
        if (!provider.createBuildJob) {
          throw new Error(`Backend ${provider.descriptor.label} does not build model engines`);
        }

        // Use module-level build job for cancellation support
        activeBuildJob = provider.createBuildJob();

        // Send progress updates
        const sendProgress = (type: 'converting' | 'complete' | 'error', progress: number, message: string, enginePath?: string) => {
          mainWindow?.webContents.send('model-init-progress', {
            type,
            progress,
            message,
            enginePath
          });
        };

        sendProgress('converting', 0, 'Starting TensorRT engine conversion...');

        // Add precision suffix to model name, unless it already declares one
        const modelNameWithPrecision = withPrecisionSuffix(
          params.modelName,
          precisionOf(params.useFp32, params.useBf16)
        );
        const enginePath = path.join(PATHS.MODELS, `${modelNameWithPrecision}.engine`);

        try {
          await activeBuildJob.buildWithProgress(
            {
              onnxPath: params.onnxPath,
              enginePath,
              minShapes: params.minShapes,
              optShapes: params.optShapes,
              maxShapes: params.maxShapes,
              useFp32: params.useFp32,
              useBf16: params.useBf16,
              useStaticShape: params.useStaticShape || false,
              customBuildParams: params.useCustomTrtexecParams ? params.customTrtexecParams : undefined,
            },
            0,
            99,
            (message: string, progress: number) => {
              sendProgress('converting', progress, message);
            }
          );
        } catch (conversionError: any) {
          // Check if this is a fallback notification
          if (conversionError.message === 'STATIC_SHAPE_FALLBACK') {
            logger.model('Static shape build succeeded with fallback to no shape parameters');
            const shapeInfo = conversionError.detectedShape ? ` Detected shape: ${conversionError.detectedShape}` : '';
            // Send shape and static mode info to frontend
            mainWindow?.webContents.send('model-init-progress', {
              type: 'converting',
              progress: 99,
              message: `Build succeeded without shape parameters.${shapeInfo}`,
              detectedShape: conversionError.detectedShape,
              detectedStatic: true
            });
          } else if (conversionError.message === 'MODEL_BUILD_CANCELLED') {
            // Cancellation is expected control flow. The renderer already
            // clears the progress UI when the user presses Cancel, so do not
            // emit a second misleading "build failed" notification when the
            // killed child process reports a nonzero exit code.
            logger.model('Model import cancelled');
            activeBuildJob = null;
            return {
              success: false,
              error: 'Model build cancelled'
            };
          } else {
            throw conversionError;
          }
        }
              
        logger.model(`Engine created: ${enginePath}`);
        
        // Save model metadata including type and display tag
        await configManager.setModelMetadata(
          modelNameWithPrecision,
          params.useFp32,
          (params.modelType as 'vsr' | 'image') || 'image',
          params.displayTag,
          undefined,
          params.useBf16,
          params.modelType === 'vsr' ? params.temporalFrames : undefined
        );

        // Complete
        sendProgress('complete', 100, 'Model initialized successfully!', enginePath);
        activeBuildJob = null;

        return {
          success: true,
          enginePath
        };

      } catch (error) {
        activeBuildJob = null;
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        logger.error('Model initialization failed:', errorMsg);
        
        mainWindow?.webContents.send('model-init-progress', {
          type: 'error',
          progress: 0,
          message: `Initialization failed: ${errorMsg}`
        });
        
        return {
          success: false,
          error: errorMsg
        };
      }
    });
  });

  ipcMain.handle('import-custom-model', async (event, params: {
    onnxPath: string;
    modelName: string;
    minShapes: string;
    optShapes: string;
    maxShapes: string;
    useFp32: boolean;
    useBf16?: boolean;
    modelType?: string;
    temporalFrames?: number;
    backend?: string;
    displayTag?: string;
    useStaticShape?: boolean;
    useCustomTrtexecParams?: boolean;
    customTrtexecParams?: string;
    skipValidation?: boolean;
  }) => {
    return await withLogSeparator(async () => {
      const provider = resolveProvider(params.backend);
      logger.model('Starting custom model import');
      logger.model(`ONNX path: ${params.onnxPath}`);
      logger.model(`Model name: ${params.modelName}`);
      logger.model(`Precision: ${params.useFp32 ? 'FP32' : params.useBf16 ? 'BF16' : 'FP16'}`);
      logger.model(`Model type: ${params.modelType || 'image'}`);
      logger.model(`Target backend: ${provider.descriptor.label}`);
      logger.model(`Skip validation: ${params.skipValidation ? 'yes' : 'no'}`);

      try {

        // Validate ONNX model unless skipValidation is set
        if (!params.skipValidation) {
          const { ModelValidator } = await import('./modelValidator');
          const validator = new ModelValidator();
          
          sendModelImportProgress(mainWindow, 'validating', 10, 'Validating ONNX model...');
          const validationResult = await validator.validateOnnxModel(params.onnxPath);
          
          if (!validationResult.isValid) {
            logger.error(`Model validation failed: ${validationResult.error}`);
            sendModelImportProgress(mainWindow, 'error', 0, validationResult.error || 'Model validation failed');
            return {
              success: false,
              error: validationResult.error || 'Model validation failed'
            };
          }

          // A graph ONNX Runtime rejects (any BF16 one) is still buildable into
          // a TensorRT engine, but a backend that runs the ONNX directly would
          // only hit the same error later, at preview or encode time.
          if (validationResult.runtimeError && !provider.descriptor.requiresEngineBuild) {
            const error = `${provider.descriptor.label} runs models through ONNX Runtime, which cannot load this one: ${validationResult.runtimeError}`;
            logger.error(`Model validation failed: ${error}`);
            sendModelImportProgress(mainWindow, 'error', 0, error);
            return { success: false, error };
          }

          logger.model('Model validation passed');
        } else {
          logger.model('Skipping ONNX model validation as requested');
        }
        
        // Copy ONNX
        sendModelImportProgress(mainWindow, 'copying', 30, 'Copying ONNX model to models directory...');
        await fs.ensureDir(PATHS.MODELS);
        
        // Add precision suffix to model name only if it doesn't already have fp16/fp32/bf16
        const modelNameWithPrecision = withPrecisionSuffix(
          params.modelName,
          precisionOf(params.useFp32, params.useBf16)
        );
        if (modelNameWithPrecision === params.modelName) {
          logger.model('Model name already contains precision suffix, using as-is');
        } else {
          logger.model(`Added precision suffix: ${modelNameWithPrecision.slice(params.modelName.length)}`);
        }
        
        const targetOnnxPath = path.join(PATHS.MODELS, `${modelNameWithPrecision}.onnx`);
        await fs.copy(params.onnxPath, targetOnnxPath, { overwrite: true });
        logger.model(`ONNX copied to: ${targetOnnxPath}`);
        
        // Save model metadata including type and display tag
        await configManager.setModelMetadata(
          modelNameWithPrecision,
          params.useFp32,
          (params.modelType as 'vsr' | 'image') || 'image',
          params.displayTag,
          undefined,
          params.useBf16,
          params.modelType === 'vsr' ? params.temporalFrames : undefined
        );

        // Backends that run ONNX directly (DirectML, and later NCNN/OpenVINO)
        // are done after the copy — no engine build step.
        if (!provider.descriptor.requiresEngineBuild || !provider.createBuildJob) {
          logger.model(`${provider.descriptor.label} runs ONNX directly - skipping engine build`);
          sendModelImportProgress(mainWindow, 'complete', 100, `Model imported successfully for ${provider.descriptor.label} use!`, targetOnnxPath);
          return {
            success: true,
            onnxPath: targetOnnxPath
          };
        }

        // Build the backend-specific engine (TensorRT)
        sendModelImportProgress(mainWindow, 'converting', 30, `Converting to TensorRT engine (${params.useFp32 ? 'FP32' : params.useBf16 ? 'BF16' : 'FP16'})...`);

        const enginePath = path.join(PATHS.MODELS, `${modelNameWithPrecision}.engine`);

        // Use module-level build job for cancellation support
        activeBuildJob = provider.createBuildJob();

        try {
          await activeBuildJob.buildWithProgress(
            {
              onnxPath: targetOnnxPath,
              enginePath,
              minShapes: params.minShapes,
              optShapes: params.optShapes,
              maxShapes: params.maxShapes,
              useFp32: params.useFp32,
              useBf16: params.useBf16,
              useStaticShape: params.useStaticShape || false,
              customBuildParams: params.useCustomTrtexecParams ? params.customTrtexecParams : undefined,
            },
            30,
            69,
            (message: string, progress: number) => {
              const cleanMessage = message.replace(/\.\.\.\s\d+%$/, '...');
              sendModelImportProgress(mainWindow, 'converting', progress, cleanMessage);
            }
          );
        } catch (conversionError: any) {
          // Check if this is a fallback notification
          if (conversionError.message === 'STATIC_SHAPE_FALLBACK') {
            logger.model('Static shape build succeeded with fallback to no shape parameters');
            const shapeInfo = conversionError.detectedShape ? ` Detected shape: ${conversionError.detectedShape}` : '';
            // Send shape and static mode info to frontend
            mainWindow?.webContents.send('model-import-progress', {
              type: 'converting',
              progress: 69,
              message: `Build succeeded without shape parameters.${shapeInfo}`,
              detectedShape: conversionError.detectedShape,
              detectedStatic: true
            });
          } else if (conversionError.message === 'MODEL_BUILD_CANCELLED') {
            logger.model('Model import cancelled');
            activeBuildJob = null;
            return {
              success: false,
              error: 'Model build cancelled'
            };
          } else {
            throw conversionError;
          }
        }
              
        logger.model(`Engine created: ${enginePath}`);
        
        // Complete
        sendModelImportProgress(mainWindow, 'complete', 100, 'Model imported successfully!', enginePath);
        activeBuildJob = null;

        return {
          success: true,
          enginePath
        };

      } catch (error) {
        activeBuildJob = null;
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        logger.error('Model import failed:', errorMsg);
        sendModelImportProgress(mainWindow, 'error', 0, `Import failed: ${errorMsg}`);
        
        return {
          success: false,
          error: errorMsg
        };
      }
    });
  });

  ipcMain.handle('get-model-metadata', async (event, modelId: string) => {
    logger.info(`Getting metadata for model: ${modelId}`);
    try {
      // Model ID is now the exact filename without extension - direct lookup
      const metadata = configManager.getModelMetadata(modelId);
      return metadata;
    } catch (error) {
      logger.error('Error getting model metadata:', error);
      throw error;
    }
  });

  ipcMain.handle('update-model-metadata', async (event, modelId: string, metadata: any) => {
    logger.info(`Updating metadata for model: ${modelId}`);
    try {
      // Model ID is now the exact filename without extension - direct lookup
      // If metadata doesn't exist yet, create it
      const existing = configManager.getModelMetadata(modelId);
      if (!existing) {
        await configManager.setModelMetadata(
          modelId,
          metadata.useFp32 ?? false,
          metadata.modelType ?? 'image',
          metadata.displayTag,
          metadata.description
        );
      } else {
        await configManager.updateModelMetadata(modelId, metadata);
      }
      return { success: true };
    } catch (error) {
      logger.error('Error updating model metadata:', error);
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: errorMsg
      };
    }
  });

  handleValidated('delete-model', z.tuple([z.string().min(1), z.string().min(1)]), async ([modelPath, modelId]) => {
    logger.info(`Deleting model: ${modelPath} (id: ${modelId})`);
    try {
      // Delete only the specific file being requested
      await fs.remove(modelPath);
      logger.info(`Deleted file: ${modelPath}`);

      // Delete metadata only for this specific model ID
      await configManager.deleteModelMetadata(modelId);
      logger.info(`Deleted metadata for model: ${modelId}`);

      return { success: true };
    } catch (error) {
      logger.error('Error deleting model:', error);
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: errorMsg
      };
    }
  });

  handleValidated('rename-model', z.tuple([z.string().min(1), z.string().min(1), z.string().min(1)]), async ([modelPath, modelId, newName]) => {
    logger.info(`Renaming model: ${modelId} -> ${newName}`);
    try {
      const ext = path.extname(modelPath);
      const dir = path.dirname(modelPath);
      const newPath = path.join(dir, `${newName}${ext}`);

      // Check if target already exists
      if (await fs.pathExists(newPath)) {
        return { success: false, error: `A model named "${newName}${ext}" already exists` };
      }

      // Rename the file
      await fs.rename(modelPath, newPath);
      logger.info(`Renamed file: ${modelPath} -> ${newPath}`);

      // Migrate metadata from old key to new key
      const oldMetadata = configManager.getModelMetadata(modelId);
      if (oldMetadata) {
        await configManager.setModelMetadata(
          newName,
          oldMetadata.useFp32,
          oldMetadata.modelType,
          oldMetadata.displayTag,
          oldMetadata.description,
          oldMetadata.useBf16,
          oldMetadata.temporalFrames
        );
        // Copy category if present
        if (oldMetadata.category) {
          await configManager.updateModelMetadata(newName, { category: oldMetadata.category });
        }
        await configManager.deleteModelMetadata(modelId);
        logger.info(`Migrated metadata: ${modelId} -> ${newName}`);
      }

      return { success: true, newPath, newId: newName };
    } catch (error) {
      logger.error('Error renaming model:', error);
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMsg };
    }
  });

  ipcMain.handle('cancel-model-import', async () => {
    logger.info('Cancelling model import/initialization');
    cancelActiveModelOperation();
    return { success: true };
  });

  ipcMain.handle('force-stop-model-import', async () => {
    logger.info('Force stopping model import/initialization');
    if (activeBuildJob) {
      activeBuildJob.forceStop();
      activeBuildJob = null;
    }
    return { success: true };
  });

  handleValidated('validate-onnx-model', z.string().min(1), async (onnxPath) => {
    logger.info(`Validating ONNX model: ${onnxPath}`);
    try {
      const { ModelValidator } = await import('./modelValidator');
      const validator = new ModelValidator();
      const result = await validator.validateOnnxModel(onnxPath);
      
      return {
        isValid: result.isValid,
        error: result.error,
        inputShape: result.inputShape,
        outputShape: result.outputShape,
        inputName: result.inputName || 'input', // Default to 'input' if not found
        isStatic: result.isStatic,
        inputDataType: result.inputDataType,
        precision: result.precision
      };
    } catch (error) {
      logger.error('Error validating ONNX model:', error);
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      return {
        isValid: false,
        error: errorMsg
      };
    }
  });

  ipcMain.handle('get-model-categories', async () => {
    logger.info('Getting model categories');
    try {
      return configManager.getAllModelCategories();
    } catch (error) {
      logger.error('Error getting model categories:', error);
      return [];
    }
  });

  ipcMain.handle('update-model-category', async (event, modelId: string, category: string | string[] | undefined) => {
    logger.info(`Updating category for model: ${modelId}`);
    try {
      await configManager.updateModelMetadata(modelId, { category });
      return { success: true };
    } catch (error) {
      logger.error('Error updating model category:', error);
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMsg };
    }
  });
}
