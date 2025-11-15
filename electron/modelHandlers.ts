import { ipcMain, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs-extra';
import { logger } from './logger';
import { PATHS } from './constants';
import { configManager } from './configManager';
import { withLogSeparator } from './utils';
import { sendModelImportProgress } from './ipcUtilities';

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
      
      // Helper function to extract precision from config metadata
      const getPrecision = (baseName: string): string => {
        const metadata = configManager.getModelMetadata(baseName);
        return metadata?.useFp32 ? 'FP32' : 'FP16';
      };

      // Helper function to clean model name by removing technical suffixes
      const cleanModelName = (filename: string): string => {
        // Remove file extension
        let name = filename.replace(/\.(onnx|engine)$/, '');
        // Remove precision suffixes
        name = name.replace(/_(fp16|fp32)$/i, '');
        return name;
      };

      // Helper function to get model type label
      const getModelTypeLabel = (baseName: string): string => {
        const metadata = configManager.getModelMetadata(baseName);
        if (metadata?.modelType === 'image') return 'Image';
        return 'Video'; // Default to Video for TSPAN models
      };

      // Helper function to get custom display tag
      const getDisplayTag = (baseName: string): string => {
        const metadata = configManager.getModelMetadata(baseName);
        return metadata?.displayTag ? ` [${metadata.displayTag}]` : '';
      };

      // Include both .engine files (for TensorRT) and .onnx files (for DirectML)
      const models = [
        ...engineFiles.map(file => {
          const baseName = path.basename(file, '.engine');
          const cleanName = cleanModelName(file);
          const precision = getPrecision(baseName);
          const modelTypeLabel = getModelTypeLabel(baseName);
          const displayTag = getDisplayTag(baseName);
          const modelType = configManager.getModelMetadata(baseName)?.modelType || 'tspan';
          return {
            id: baseName,
            name: `${cleanName}${displayTag} (${modelTypeLabel}, ${precision})`,
            path: path.join(PATHS.MODELS, file),
            precision,
            backend: 'tensorrt',
            modelType
          };
        }),
        ...onnxFiles.map(file => {
          const baseName = path.basename(file, '.onnx');
          const cleanName = cleanModelName(file);
          const precision = getPrecision(baseName);
          const modelTypeLabel = getModelTypeLabel(baseName);
          const displayTag = getDisplayTag(baseName);
          
          // Check if any engine file corresponds to this ONNX file
          // Engine files are named like: model_fp16_fp16.engine (precision duplicated)
          // So we check if any engine file starts with the ONNX basename
          const hasEngine = engineFiles.some(engineFile => {
            const engineBaseName = path.basename(engineFile, '.engine');
            // Check if engine name starts with ONNX name and has precision suffix duplicated
            return engineBaseName.startsWith(baseName + '_');
          });
          
          const modelType = configManager.getModelMetadata(baseName)?.modelType || 'tspan';
          return {
            id: baseName + ' (ONNX)',
            name: `${cleanName}${displayTag} (${modelTypeLabel}, ${precision})`,
            path: path.join(PATHS.MODELS, file),
            precision,
            backend: 'onnx',
            hasEngine,
            modelType
          };
        })
      ];
      
      logger.info(`Found ${models.length} model(s): ${models.map(m => m.name).join(', ')}`);
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
      logger.model(`Precision: ${params.useFp32 ? 'FP32' : 'FP16'}`);
      logger.model(`Model type: ${params.modelType || 'tspan'}`);
      
      try {
        const { ModelExtractor } = await import('./modelExtractor');
        const modelExtractor = new ModelExtractor();
        
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
          await modelExtractor.convertToEngineWithProgress(
            params.onnxPath,
            enginePath,
            params.minShapes,
            params.optShapes,
            params.maxShapes,
            params.useFp32,
            params.useStaticShape || false,
            0,
            99,
            (message, progress) => {
              sendProgress('converting', progress, message);
            },
            params.useCustomTrtexecParams ? params.customTrtexecParams : undefined
          );
        } catch (conversionError: any) {
          // Check if this is a fallback notification
          if (conversionError.message === 'STATIC_SHAPE_FALLBACK') {
            logger.model('Static shape build succeeded with fallback to no shape parameters');
            const shapeInfo = conversionError.detectedShape ? ` Detected shape: ${conversionError.detectedShape}` : '';
            sendProgress('converting', 99, `Build succeeded without shape parameters.${shapeInfo}`);
          } else {
            throw conversionError;
          }
        }
              
        logger.model(`Engine created: ${enginePath}`);
        
        // Save model metadata including type and display tag
        await configManager.setModelMetadata(
          modelNameWithPrecision, 
          params.useFp32,
          (params.modelType as 'tspan' | 'image') || 'tspan',
          params.displayTag
        );
        
        // Complete
        sendProgress('complete', 100, 'Model initialized successfully!', enginePath);
        
        return {
          success: true,
          enginePath
        };
        
      } catch (error) {
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
      logger.model(`Precision: ${params.useFp32 ? 'FP32' : 'FP16'}`);
      logger.model(`Model type: ${params.modelType || 'tspan'}`);
      logger.model(`DirectML mode: ${params.useDirectML ? 'enabled' : 'disabled'}`);
      
      try {
        const { ModelValidator } = await import('./modelValidator');
        const { ModelExtractor } = await import('./modelExtractor');
        
        const validator = new ModelValidator();
        const modelExtractor = new ModelExtractor();
        
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
          (params.modelType as 'tspan' | 'image') || 'tspan',
          params.displayTag
        );
        
        // If DirectML mode is enabled, skip TensorRT conversion
        if (params.useDirectML) {
          logger.model('DirectML mode enabled - skipping TensorRT conversion');
          sendModelImportProgress(mainWindow, 'complete', 100, 'Model imported successfully for DirectML use!', targetOnnxPath);
          
          return {
            success: true,
            onnxPath: targetOnnxPath
          };
        }
        
        // Convert to engine (TensorRT mode only)
        sendModelImportProgress(mainWindow, 'converting', 30, `Converting to TensorRT engine (${params.useFp32 ? 'FP32' : 'FP16'})...`);
        
        const enginePath = path.join(PATHS.MODELS, `${modelNameWithPrecision}.engine`);
        
        try {
          await modelExtractor.convertToEngineWithProgress(
            targetOnnxPath,
            enginePath,
            params.minShapes,
            params.optShapes,
            params.maxShapes,
            params.useFp32,
            params.useStaticShape || false,
            30,
            69,
            (message, progress) => {
              const cleanMessage = message.replace(/\.\.\.\s\d+%$/, '...');
              sendModelImportProgress(mainWindow, 'converting', progress, cleanMessage);
            },
            params.useCustomTrtexecParams ? params.customTrtexecParams : undefined
          );
        } catch (conversionError: any) {
          // Check if this is a fallback notification
          if (conversionError.message === 'STATIC_SHAPE_FALLBACK') {
            logger.model('Static shape build succeeded with fallback to no shape parameters');
            const shapeInfo = conversionError.detectedShape ? ` Detected shape: ${conversionError.detectedShape}` : '';
            sendModelImportProgress(mainWindow, 'converting', 69, `Build succeeded without shape parameters.${shapeInfo}`);
          } else {
            throw conversionError;
          }
        }
              
        logger.model(`Engine created: ${enginePath}`);
        
        // Complete
        sendModelImportProgress(mainWindow, 'complete', 100, 'Model imported successfully!', enginePath);
        
        return {
          success: true,
          enginePath
        };
        
      } catch (error) {
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
      await configManager.updateModelMetadata(modelId, metadata);
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
    logger.info(`Deleting model: ${modelPath}`);
    try {
      // Delete the physical file(s)
      await fs.remove(modelPath);
      logger.info(`Deleted file: ${modelPath}`);
      
      // If it's an ONNX file, also delete the corresponding engine file if it exists
      if (modelPath.endsWith('.onnx')) {
        const enginePath = modelPath.replace('.onnx', '_fp16.engine').replace('.onnx', '_fp32.engine');
        const baseName = path.basename(modelPath, '.onnx');
        const dir = path.dirname(modelPath);
        
        // Check for both fp16 and fp32 engine variants
        const enginePaths = [
          path.join(dir, `${baseName}_fp16.engine`),
          path.join(dir, `${baseName}_fp32.engine`),
          path.join(dir, `${baseName}_fp16_fp16.engine`),
          path.join(dir, `${baseName}_fp32_fp32.engine`)
        ];
        
        for (const enginePath of enginePaths) {
          if (await fs.pathExists(enginePath)) {
            await fs.remove(enginePath);
            logger.info(`Deleted engine file: ${enginePath}`);
          }
        }
      }
      
      // Delete metadata from config
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
}
