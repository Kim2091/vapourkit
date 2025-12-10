import { ipcMain, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs-extra';
import { logger } from './logger';
import { PATHS } from './constants';
import { configManager } from './configManager';
import { withLogSeparator } from './utils';
import { sendModelImportProgress } from './ipcUtilities';
import { ModelExtractor } from './modelExtractor';

// Module-level ModelExtractor instance for cancellation support
let activeModelExtractor: ModelExtractor | null = null;

/**
 * Cancels any active model conversion/import operation
 */
export function cancelActiveModelOperation(): void {
  if (activeModelExtractor) {
    activeModelExtractor.cancelConversion();
    activeModelExtractor = null;
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
          const id = path.basename(file, '.engine');
          const metadata = configManager.getModelMetadata(id);
          return {
            id,
            name: id, // Clean: just the filename without extension
            path: path.join(PATHS.MODELS, file),
            precision: metadata?.useFp32 ? 'FP32' : 'FP16',
            backend: 'tensorrt' as const,
            modelType: metadata?.modelType || 'image',
            displayTag: metadata?.displayTag,
            description: metadata?.description
          };
        }),
        ...onnxFiles.map(file => {
          const id = path.basename(file, '.onnx');
          const metadata = configManager.getModelMetadata(id);
          const hasEngine = onnxBasenamesWithEngines.has(id);
          
          return {
            id,
            name: id, // Clean: just the filename without extension
            path: path.join(PATHS.MODELS, file),
            precision: metadata?.useFp32 ? 'FP32' : 'FP16',
            backend: 'onnx' as const,
            hasEngine,
            modelType: metadata?.modelType || 'image',
            displayTag: metadata?.displayTag,
            description: metadata?.description
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
        // Use module-level extractor for cancellation support
        activeModelExtractor = new ModelExtractor();
        
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
        
        // Add precision suffix to model name
        const precisionSuffix = params.useFp32 ? '_fp32' : '_fp16';
        const modelNameWithPrecision = `${params.modelName}${precisionSuffix}`;
        const enginePath = path.join(PATHS.MODELS, `${modelNameWithPrecision}.engine`);
        
        try {
          await activeModelExtractor.convertToEngineWithProgress(
            params.onnxPath,
            enginePath,
            params.minShapes,
            params.optShapes,
            params.maxShapes,
            params.useFp32,
            params.useStaticShape || false,
            0,
            99,
            (message: string, progress: number) => {
              sendProgress('converting', progress, message);
            },
            params.useCustomTrtexecParams ? params.customTrtexecParams : undefined,
            params.useBf16
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
          } else {
            throw conversionError;
          }
        }
              
        logger.model(`Engine created: ${enginePath}`);
        
        // Save model metadata including type and display tag
        await configManager.setModelMetadata(
          modelNameWithPrecision, 
          params.useFp32,
          (params.modelType as 'tspan' | 'image') || 'image',
          params.displayTag,
          undefined,
          params.useBf16
        );
        
        // Complete
        sendProgress('complete', 100, 'Model initialized successfully!', enginePath);
        activeModelExtractor = null;
        
        return {
          success: true,
          enginePath
        };
        
      } catch (error) {
        activeModelExtractor = null;
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
    useDirectML?: boolean;
    displayTag?: string;
    useStaticShape?: boolean;
    useCustomTrtexecParams?: boolean;
    customTrtexecParams?: string;
  }) => {
    return await withLogSeparator(async () => {
      logger.model('Starting custom model import');
      logger.model(`ONNX path: ${params.onnxPath}`);
      logger.model(`Model name: ${params.modelName}`);
      logger.model(`Precision: ${params.useFp32 ? 'FP32' : params.useBf16 ? 'BF16' : 'FP16'}`);
      logger.model(`Model type: ${params.modelType || 'image'}`);
      logger.model(`DirectML mode: ${params.useDirectML ? 'enabled' : 'disabled'}`);
      
      try {
        const { ModelValidator } = await import('./modelValidator');
        
        const validator = new ModelValidator();
        // Use module-level extractor for cancellation support
        activeModelExtractor = new ModelExtractor();
        
        // Validate
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
        
        logger.model('Model validation passed');
        
        // Copy ONNX
        sendModelImportProgress(mainWindow, 'copying', 30, 'Copying ONNX model to models directory...');
        await fs.ensureDir(PATHS.MODELS);
        
        // Add precision suffix to model name only if it doesn't already have fp16/fp32
        const modelNameLower = params.modelName.toLowerCase();
        const hasPrecisionSuffix = modelNameLower.includes('fp16') || modelNameLower.includes('fp32');
        
        let modelNameWithPrecision: string;
        if (hasPrecisionSuffix) {
          modelNameWithPrecision = params.modelName;
          logger.model('Model name already contains precision suffix, using as-is');
        } else {
          const precisionSuffix = params.useFp32 ? '_fp32' : '_fp16';
          modelNameWithPrecision = `${params.modelName}${precisionSuffix}`;
          logger.model(`Added precision suffix: ${precisionSuffix}`);
        }
        
        const targetOnnxPath = path.join(PATHS.MODELS, `${modelNameWithPrecision}.onnx`);
        await fs.copy(params.onnxPath, targetOnnxPath, { overwrite: true });
        logger.model(`ONNX copied to: ${targetOnnxPath}`);
        
        // Save model metadata including type and display tag
        await configManager.setModelMetadata(
          modelNameWithPrecision, 
          params.useFp32,
          (params.modelType as 'tspan' | 'image') || 'image',
          params.displayTag,
          undefined,
          params.useBf16
        );
        
        // If DirectML mode is enabled, skip TensorRT conversion
        if (params.useDirectML) {
          logger.model('DirectML mode enabled - skipping TensorRT conversion');
          sendModelImportProgress(mainWindow, 'complete', 100, 'Model imported successfully for DirectML use!', targetOnnxPath);
          activeModelExtractor = null;
          
          return {
            success: true,
            onnxPath: targetOnnxPath
          };
        }
        
        // Convert to engine (TensorRT mode only)
        sendModelImportProgress(mainWindow, 'converting', 30, `Converting to TensorRT engine (${params.useFp32 ? 'FP32' : params.useBf16 ? 'BF16' : 'FP16'})...`);
        
        const enginePath = path.join(PATHS.MODELS, `${modelNameWithPrecision}.engine`);
        
        try {
          await activeModelExtractor!.convertToEngineWithProgress(
            targetOnnxPath,
            enginePath,
            params.minShapes,
            params.optShapes,
            params.maxShapes,
            params.useFp32,
            params.useStaticShape || false,
            30,
            69,
            (message: string, progress: number) => {
              const cleanMessage = message.replace(/\.\.\.\s\d+%$/, '...');
              sendModelImportProgress(mainWindow, 'converting', progress, cleanMessage);
            },
            params.useCustomTrtexecParams ? params.customTrtexecParams : undefined,
            params.useBf16
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
          } else {
            throw conversionError;
          }
        }
              
        logger.model(`Engine created: ${enginePath}`);
        
        // Complete
        sendModelImportProgress(mainWindow, 'complete', 100, 'Model imported successfully!', enginePath);
        activeModelExtractor = null;
        
        return {
          success: true,
          enginePath
        };
        
      } catch (error) {
        activeModelExtractor = null;
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

  ipcMain.handle('delete-model', async (event, modelPath: string, modelId: string) => {
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

  ipcMain.handle('cancel-model-import', async () => {
    logger.info('Cancelling model import/initialization');
    cancelActiveModelOperation();
    return { success: true };
  });

  ipcMain.handle('validate-onnx-model', async (event, onnxPath: string) => {
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
        isStatic: result.isStatic // Include static detection
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
}
