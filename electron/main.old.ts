import { app, BrowserWindow, ipcMain, dialog, protocol, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs-extra';
import { DependencyManager } from './dependencyManager';
import { VapourSynthScriptGenerator } from './scriptGenerator';
import { UpscaleExecutor } from './upscaleExecutor';
import { logger } from './logger';
import { PATHS } from './constants';
import { withLogSeparator, detectCudaSupport, fixAsarPath } from './utils';
import { configManager } from './configManager';
import { TemplateManager } from './templateManager';
import { PluginInstaller } from './pluginInstaller';
import { FFmpegManager } from './ffmpegManager';

let mainWindow: BrowserWindow | null = null;
let dependencyManager: DependencyManager;
let scriptGenerator: VapourSynthScriptGenerator;
let upscaleExecutor: UpscaleExecutor | null = null;
let templateManager: TemplateManager;
let pluginInstaller: PluginInstaller;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Wraps an IPC handler with standard error handling and logging
 */
function createIpcHandler<T>(
  handlerName: string,
  handler: () => Promise<T>,
  options: { 
    logResult?: boolean;
    throwOnError?: boolean;
    useLogSeparator?: boolean;
  } = {}
): () => Promise<T | { success: false; error: string }> {
  const { logResult = false, throwOnError = false, useLogSeparator = false } = options;
  
  const wrappedHandler = async () => {
    logger.info(`IPC Handler: ${handlerName}`);
    try {
      const result = await handler();
      if (logResult) {
        logger.info(`${handlerName} completed:`, result);
      } else {
        logger.info(`${handlerName} completed successfully`);
      }
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`${handlerName} failed:`, errorMsg);
      
      if (throwOnError) {
        throw error;
      }
      
      return { success: false, error: errorMsg } as any;
    }
  };
  
  return useLogSeparator ? () => withLogSeparator(wrappedHandler) : wrappedHandler;
}

/**
 * Sends progress updates for model import
 */
function sendModelImportProgress(
  type: 'validating' | 'copying' | 'converting' | 'complete' | 'error',
  progress: number,
  message: string,
  enginePath?: string
) {
  mainWindow?.webContents.send('model-import-progress', {
    type,
    progress,
    message,
    enginePath
  });
}

/**
 * Handles dialog result with cancellation check
 */
function handleDialogResult<T>(
  result: { canceled: boolean; filePath?: string; filePaths?: string[] },
  logContext: string
): T | null {
  if (result.canceled) {
    logger.info(`${logContext} canceled`);
    return null;
  }
  
  const selectedPath = result.filePath || (result.filePaths && result.filePaths[0]);
  if (selectedPath) {
    logger.info(`${logContext} selected: ${selectedPath}`);
    return selectedPath as T;
  }
  
  return null;
}

/**
 * Formats bytes to human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Extracts video metadata using ffmpeg
 */
async function extractVideoMetadata(filePath: string): Promise<{
  resolution?: string;
  fps?: number;
  pixelFormat?: string;
}> {
  try {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    
    const ffmpegPath = FFmpegManager.getFFmpegPath();
    if (!ffmpegPath) {
      logger.warn('FFmpeg not available for metadata extraction');
      return {};
    }
    
    logger.info(`Using ffmpeg at: ${ffmpegPath}`);
    
    const { stdout, stderr } = await execFileAsync(ffmpegPath, [
      '-i', filePath,
      '-hide_banner'
    ], { 
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 10
    }).catch((error: any) => {
      return { stdout: error.stdout || '', stderr: error.stderr || '' };
    });
    
    const output = stderr + stdout;
    logger.debug(`FFmpeg output: ${output.substring(0, 500)}`);
    
    let resolution: string | undefined;
    let fps: number | undefined;
    
    // Parse resolution
    const resolutionMatch = output.match(/Stream.*Video.*?[,\s](\d{2,5})x(\d{2,5})[,\s]/i);
    if (resolutionMatch) {
      resolution = `${resolutionMatch[1]}x${resolutionMatch[2]}`;
      logger.info(`Parsed resolution: ${resolution}`);
    } else {
      logger.warn('Could not parse resolution from ffmpeg output');
    }
    
    // Parse FPS
    const fpsMatch = output.match(/(\d+(?:\.\d+)?)\s*(?:fps|tbr)/i);
    if (fpsMatch) {
      fps = Math.round(parseFloat(fpsMatch[1]) * 100) / 100;
      logger.info(`Parsed FPS: ${fps}`);
    } else {
      logger.warn('Could not parse FPS from ffmpeg output');
    }
    
    return { resolution, fps };
  } catch (probeError) {
    logger.error('Error extracting video metadata with ffmpeg:', probeError);
    return {};
  }
}

// ============================================================================
// WINDOW AND APP LIFECYCLE
// ============================================================================

function createWindow() {
  logger.info('Creating main window');
  
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0e1a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    frame: true,
    titleBarStyle: 'default',
    autoHideMenuBar: true
  });

  if (process.env.NODE_ENV === 'development') {
    logger.info('Loading development URL: http://localhost:5173');
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    const indexPath = path.join(__dirname, '../renderer/index.html');
    logger.info(`Loading production file: ${indexPath}`);
    mainWindow.loadFile(indexPath);
  }

  mainWindow.on('closed', () => {
    logger.info('Main window closed');
    mainWindow = null;
  });

  dependencyManager = new DependencyManager(mainWindow);
  scriptGenerator = new VapourSynthScriptGenerator();
  templateManager = new TemplateManager();
  pluginInstaller = new PluginInstaller(mainWindow);
  logger.info('Managers initialized');
  
  // Initialize default templates
  templateManager.createDefaultTemplates().catch(err => {
    logger.error('Error creating default templates:', err);
  });
}

// Set portable userData path (makes localStorage local to installation)
if (app.isPackaged) {
  const portableUserDataPath = path.join(path.dirname(app.getPath('exe')), 'data', 'user-data');
  app.setPath('userData', portableUserDataPath);
  logger.info(`Using portable userData path: ${portableUserDataPath}`);
}

configManager.load().then(() => {
  const devMode = configManager.getDeveloperMode();
  logger.initializeDeveloperMode(devMode, mainWindow);
  logger.info(`Developer mode initialized: ${devMode}`);
});

// ============================================================================
// IPC HANDLERS
// ============================================================================

ipcMain.handle('check-dependencies', 
  createIpcHandler(
    'check-dependencies',
    () => dependencyManager.checkDependencies(),
    { logResult: true, throwOnError: true }
  )
);

ipcMain.handle('detect-cuda-support', 
  createIpcHandler(
    'detect-cuda-support',
    async () => {
      const hasCuda = await detectCudaSupport();
      logger.info(`CUDA detection result: ${hasCuda}`);
      return hasCuda;
    },
    { logResult: true }
  )
);

ipcMain.handle('setup-dependencies',
  createIpcHandler(
    'setup-dependencies',
    async () => {
      await dependencyManager.setupDependencies();
      // Reload config after setup to get the stock config with model metadata
      await configManager.load();
      logger.info('Config reloaded after setup');
      return { success: true };
    },
    { useLogSeparator: true }
  )
);

ipcMain.handle('select-video-file', async () => {
  logger.info('Opening video file selection dialog');
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Videos', extensions: ['mp4', 'avi', 'mkv', 'mov', 'webm', 'flv', 'wmv'] }
    ]
  });

  return handleDialogResult<string>(result, 'Video file selection');
});

ipcMain.handle('select-onnx-file', async () => {
  logger.info('Opening ONNX file selection dialog');
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'ONNX Models', extensions: ['onnx'] }
    ]
  });

  return handleDialogResult<string>(result, 'ONNX file selection');
});

ipcMain.handle('select-template-file', async () => {
  logger.info('Opening template file selection dialog');
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'VapourSynth Templates', extensions: ['vkfilter'] }
    ]
  });

  return handleDialogResult<string>(result, 'Template file selection');
});

ipcMain.handle('get-video-info', async (event, filePath: string) => {
  logger.info(`Getting video info for: ${filePath}`);
  try {
    const stats = await fs.stat(filePath);
    const metadata = await extractVideoMetadata(filePath);
    
    const info = {
      path: filePath,
      name: path.basename(filePath),
      size: stats.size,
      sizeFormatted: formatBytes(stats.size),
      resolution: metadata.resolution,
      fps: metadata.fps,
      pixelFormat: metadata.pixelFormat
    };
    
    logger.info(`Video info: ${info.name}, ${info.sizeFormatted}, ${metadata.resolution || 'unknown resolution'}, ${metadata.fps ? metadata.fps + ' fps' : 'unknown fps'}, ${metadata.pixelFormat || 'unknown format'}`);
    return info;
  } catch (error) {
    logger.error('Error getting video info:', error);
    throw error;
  }
});

ipcMain.handle('get-output-resolution', async (
  event,
  videoPath: string,
  modelPath: string | null,
  useDirectML?: boolean,
  upscalingEnabled?: boolean,
  filters?: any[],
  upscalePosition?: number,
  numStreams?: number
) => {
  logger.info(`Getting output info for: ${videoPath}`);
  try {
    const isUpscaling = upscalingEnabled !== false;
    
    let modelType: 'tspan' | 'image' = 'tspan';
    let useFp32 = false;
    
    if (isUpscaling && modelPath) {
      modelType = configManager.getModelType(modelPath);
      useFp32 = configManager.isModelFp32(modelPath);
    }
    
    const colorMatrixSettings = configManager.getColorMatrixSettings();
    
    const scriptPath = await scriptGenerator.generateScript({
      inputVideo: videoPath,
      enginePath: modelPath || '',
      pluginsPath: dependencyManager.getPluginsPath(),
      useDirectML: useDirectML || false,
      useFp32: useFp32,
      modelType: modelType,
      upscalingEnabled: isUpscaling,
      colorMatrix: colorMatrixSettings,
      filters: filters,
      numStreams: numStreams
    });
    
    const vspipePath = dependencyManager.getVSPipePath();
    const pythonPath = dependencyManager.getPythonExecutablePath();
    const tempExecutor = new UpscaleExecutor(vspipePath, pythonPath, null);
    
    const info = await tempExecutor.getOutputInfo(scriptPath);
    
    await scriptGenerator.cleanupScript(scriptPath);
    
    return info;
  } catch (error) {
    logger.error('Error getting output info:', error);
    return { resolution: null, fps: null };
  }
});

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
      sendModelImportProgress('validating', 10, 'Validating ONNX model...');
      const validationResult = await validator.validateOnnxModel(params.onnxPath);
      
      if (!validationResult.isValid) {
        logger.error(`Model validation failed: ${validationResult.error}`);
        sendModelImportProgress('error', 0, validationResult.error || 'Model validation failed');
        return {
          success: false,
          error: validationResult.error || 'Model validation failed'
        };
      }
      
      logger.model('Model validation passed');
      
      // Copy ONNX
      sendModelImportProgress('copying', 30, 'Copying ONNX model to models directory...');
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
        sendModelImportProgress('complete', 100, 'Model imported successfully for DirectML use!', targetOnnxPath);
        
        return {
          success: true,
          onnxPath: targetOnnxPath
        };
      }
      
      // Convert to engine (TensorRT mode only)
      sendModelImportProgress('converting', 30, `Converting to TensorRT engine (${params.useFp32 ? 'FP32' : 'FP16'})...`);
      
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
            sendModelImportProgress('converting', progress, cleanMessage);
          },
          params.useCustomTrtexecParams ? params.customTrtexecParams : undefined
        );
      } catch (conversionError: any) {
        // Check if this is a fallback notification
        if (conversionError.message === 'STATIC_SHAPE_FALLBACK') {
          logger.model('Static shape build succeeded with fallback to no shape parameters');
          const shapeInfo = conversionError.detectedShape ? ` Detected shape: ${conversionError.detectedShape}` : '';
          sendModelImportProgress('converting', 69, `Build succeeded without shape parameters.${shapeInfo}`);
        } else {
          throw conversionError;
        }
      }
            
      logger.model(`Engine created: ${enginePath}`);
      
      // Complete
      sendModelImportProgress('complete', 100, 'Model imported successfully!', enginePath);
      
      return {
        success: true,
        enginePath
      };
      
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Model import failed:', errorMsg);
      sendModelImportProgress('error', 0, `Import failed: ${errorMsg}`);
      
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

ipcMain.handle('select-output-file', async (event, defaultName: string) => {
  logger.info(`Opening output file selection dialog with default: ${defaultName}`);
  
  const ext = path.extname(defaultName).slice(1) || 'mp4';
  
  const result = await dialog.showSaveDialog({
    defaultPath: defaultName,
    filters: [
      { name: 'Video Files', extensions: [ext] },
      { name: 'All Videos', extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm'] }
    ]
  });

  return handleDialogResult<string>(result, 'Output file selection');
});

ipcMain.handle('start-upscale', async (
  event, 
  videoPath: string, 
  modelPath: string | null, 
  outputPath: string, 
  useDirectML?: boolean, 
  upscalingEnabled?: boolean,
  filters?: any[],
  upscalePosition?: number,
  numStreams?: number
) => {
  return await withLogSeparator(async () => {
    const isUpscaling = upscalingEnabled !== false; // Default to true for backward compatibility
    
    logger.upscale('Starting processing');
    logger.upscale(`Input: ${videoPath}`);
    logger.upscale(`Upscaling: ${isUpscaling ? 'enabled' : 'disabled'}`);
    if (isUpscaling && modelPath) {
      logger.upscale(`Model: ${modelPath}`);
      logger.upscale(`Backend: ${useDirectML ? 'DirectML (ONNX Runtime)' : 'TensorRT'}`);
    }
    logger.upscale(`Output: ${outputPath}`);
    
    // Log filter status
    if (filters && filters.length > 0) {
      const enabledFilters = filters.filter(f => f.enabled);
      logger.upscale(`Filters: ${enabledFilters.length} enabled`);
    }
    
    try {
      // Generate VapourSynth script
      logger.upscale('Generating VapourSynth script');
      
      let modelType: 'tspan' | 'image' = 'tspan';
      let useFp32 = false;
      
      if (isUpscaling && modelPath) {
        modelType = configManager.getModelType(modelPath);
        useFp32 = configManager.isModelFp32(modelPath);
        logger.upscale(`Model type: ${modelType}`);
      }
      
      // Handle simple mode: if upscaling is enabled with a model but no filters are enabled,
      // create a default filter from the selected model
      if (isUpscaling && modelPath && (!filters || filters.filter(f => f.enabled).length === 0)) {
        filters = [{
          id: 'default-upscale',
          enabled: true,
          filterType: 'aiModel' as const,
          preset: 'Simple Upscale',
          code: '',
          order: 0,
          modelPath: modelPath,
          modelType: modelType
        }];
        logger.upscale('Simple mode: Created default upscale filter');
      }
      
      const colorMatrixSettings = configManager.getColorMatrixSettings();
      
      const scriptPath = await scriptGenerator.generateScript({
        inputVideo: videoPath,
        enginePath: modelPath || '', // Empty string when upscaling disabled
        pluginsPath: dependencyManager.getPluginsPath(),
        useDirectML: useDirectML || false,
        useFp32: useFp32,
        modelType: modelType,
        upscalingEnabled: isUpscaling,
        colorMatrix: colorMatrixSettings,
        filters: filters,
        numStreams: numStreams
      });
      logger.upscale(`Script generated: ${scriptPath}`);

      // Initialize executor
      const vspipePath = dependencyManager.getVSPipePath();
      const pythonPath = dependencyManager.getPythonExecutablePath();
      logger.upscale(`VSPipe: ${vspipePath}`);
      logger.upscale(`Python: ${pythonPath}`);
      
      upscaleExecutor = new UpscaleExecutor(vspipePath, pythonPath, mainWindow);

      // Get frame count and execute
      logger.upscale('Getting frame count');
      const totalFrames = await upscaleExecutor.getFrameCount(scriptPath);
      logger.upscale(`Total frames to process: ${totalFrames}`);

      logger.upscale('Starting execution');
      await upscaleExecutor.execute(scriptPath, outputPath, videoPath, totalFrames);

      // Cleanup
      logger.upscale('Cleaning up script file');
      await scriptGenerator.cleanupScript(scriptPath);

      logger.upscale('Processing completed successfully');
      return { success: true, outputPath };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Processing failed:', errorMsg);
      return { success: false, error: errorMsg };
    }
  });
});

ipcMain.handle('cancel-upscale', async () => {
  logger.upscale('Canceling upscale process');
  if (upscaleExecutor) {
    upscaleExecutor.cancel();
    upscaleExecutor = null;
    logger.upscale('Upscale canceled');
  }
  return { success: true };
});

ipcMain.handle('open-output-folder', async (event, filePath: string) => {
  logger.info(`Opening output folder for: ${filePath}`);
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File does not exist: ${filePath}`);
    }
    const folderPath = path.dirname(filePath);
    await shell.openPath(folderPath);
    logger.info(`Opened folder: ${folderPath}`);
  } catch (error) {
    logger.error('Error opening output folder:', error);
    throw error;
  }
});

ipcMain.handle('compare-videos', async (event, inputPath: string, outputPath: string) => {
  logger.info(`Launching video comparison tool`);
  logger.info(`Input: ${inputPath}`);
  logger.info(`Output: ${outputPath}`);
  try {
    const { spawn } = require('child_process');
    
    // Check if video-compare exists
    if (!fs.existsSync(PATHS.VIDEO_COMPARE_EXE)) {
      throw new Error('Video comparison tool not found. Please run setup again.');
    }
    
    // Check if both video files exist
    if (!fs.existsSync(inputPath)) {
      throw new Error(`Input video not found: ${inputPath}`);
    }
    if (!fs.existsSync(outputPath)) {
      throw new Error(`Output video not found: ${outputPath}`);
    }
    
    // Launch video-compare with both videos
    logger.info(`Launching: ${PATHS.VIDEO_COMPARE_EXE}`);
    const child = spawn(PATHS.VIDEO_COMPARE_EXE, ['-W', inputPath, outputPath], {
      detached: true,
      stdio: 'ignore'
    });
    
    // Detach the child process so it runs independently
    child.unref();
    
    logger.info('Video comparison tool launched successfully');
    return { success: true };
  } catch (error) {
    logger.error('Error launching video comparison tool:', error);
    const errorMsg = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMsg };
  }
});

ipcMain.handle('read-video-file', async (event, filePath: string) => {
  logger.info(`Reading video file: ${filePath}`);
  try {
    const buffer = await fs.readFile(filePath);
    return buffer.buffer;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.errorWithDialog('Video Load Error', `Failed to read video file: ${errorMsg}`);
    throw error;
  }
});

ipcMain.handle('open-external', async (event, url: string) => {
  logger.info(`Opening external URL: ${url}`);
  await shell.openExternal(url);
  return { success: true };
});

ipcMain.handle('open-logs-folder', async () => {
  logger.info('Opening logs folder');
  try {
    const logsDir = logger.getLogsDir();
    await fs.ensureDir(logsDir);
    shell.openPath(logsDir);
    return { success: true };
  } catch (error) {
    logger.error('Error opening logs folder:', error);
    throw error;
  }
});

ipcMain.handle('open-config-folder', async () => {
  logger.info('Opening config folder');
  try {
    await fs.ensureDir(PATHS.CONFIG);
    shell.openPath(PATHS.CONFIG);
    return { success: true };
  } catch (error) {
    logger.error('Error opening config folder:', error);
    throw error;
  }
});

ipcMain.handle('open-vs-plugins-folder', async () => {
  logger.info('Opening VapourSynth plugins folder');
  try {
    await fs.ensureDir(PATHS.PLUGINS);
    shell.openPath(PATHS.PLUGINS);
    return { success: true };
  } catch (error) {
    logger.error('Error opening VS plugins folder:', error);
    throw error;
  }
});

ipcMain.handle('open-vs-scripts-folder', async () => {
  logger.info('Opening VapourSynth scripts folder');
  try {
    await fs.ensureDir(PATHS.SCRIPTS);
    shell.openPath(PATHS.SCRIPTS);
    return { success: true };
  } catch (error) {
    logger.error('Error opening VS scripts folder:', error);
    throw error;
  }
});

ipcMain.handle('get-color-matrix-settings', async () => {
  const settings = configManager.getColorMatrixSettings();
  return settings;
});

ipcMain.handle('set-color-matrix-settings', async (event, settings: { overwriteMatrix: boolean; matrix709: boolean; defaultMatrix: '709' | '170m'; defaultPrimaries: '709' | '601'; defaultTransfer: '709' | '170m' }) => {
  logger.info(`Setting color matrix: overwrite=${settings.overwriteMatrix}, matrix709=${settings.matrix709}, default=${settings.defaultMatrix}`);
  await configManager.setColorMatrixSettings(settings);
  return { success: true };
});

ipcMain.handle('get-panel-sizes', async () => {
  const sizes = configManager.getPanelSizes();
  return sizes;
});

ipcMain.handle('set-panel-sizes', async (event, sizes: { leftPanel: number; rightPanel: number }) => {
  logger.debug(`Setting panel sizes: left=${sizes.leftPanel}, right=${sizes.rightPanel}`);
  await configManager.setPanelSizes(sizes);
  return { success: true };
});

ipcMain.handle('get-filter-presets', async () => {
  const presets = configManager.getFilterPresets();
  return presets;
});

ipcMain.handle('set-filter-presets', async (event, presets: { prefilterPreset: string; postfilterPreset: string }) => {
  logger.debug(`Setting filter presets: prefilter=${presets.prefilterPreset}, postfilter=${presets.postfilterPreset}`);
  await configManager.setFilterPresets(presets);
  return { success: true };
});

ipcMain.handle('get-filter-configurations', async () => {
  const filters = configManager.getFilterConfigurations();
  return filters;
});

ipcMain.handle('set-filter-configurations', async (event, filters: any[]) => {
  logger.debug(`Setting filter configurations: ${filters.length} filters`);
  await configManager.setFilterConfigurations(filters);
  return { success: true };
});

ipcMain.handle('set-developer-mode', async (event, enabled: boolean) => {
  logger.info(`Setting developer mode: ${enabled}`);
  await configManager.setDeveloperMode(enabled);
  logger.setDeveloperMode(enabled, mainWindow);
  return { success: true, enabled };
});

ipcMain.handle('get-developer-mode', async () => {
  const enabled = configManager.getDeveloperMode();
  return { enabled };
});

ipcMain.handle('get-ffmpeg-args', async () => {
  const args = configManager.getFfmpegArgs();
  return { args };
});

ipcMain.handle('set-ffmpeg-args', async (event, args: string) => {
  logger.info(`Setting ffmpeg args: ${args}`);
  await configManager.setFfmpegArgs(args);
  return { success: true };
});

ipcMain.handle('get-default-ffmpeg-args', async () => {
  const args = configManager.getDefaultFfmpegArgs();
  return { args };
});

ipcMain.handle('get-version', async () => {
  return { version: app.getVersion() };
});

ipcMain.handle('reload-backend', async () => {
  logger.info('Reloading backend (models and configs)');
  try {
    // Reload config manager
    await configManager.load();
    logger.info('Config reloaded');
    
    // Models will be refreshed by the frontend calling get-available-models
    logger.info('Backend reload complete');
    
    return { success: true };
  } catch (error) {
    logger.error('Error reloading backend:', error);
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMsg };
  }
});

// ============================================================================
// FILTER TEMPLATE HANDLERS
// ============================================================================

ipcMain.handle('get-filter-templates', async () => {
  logger.info('Getting filter templates');
  try {
    const templates = await templateManager.loadTemplates();
    logger.info(`Loaded ${templates.length} template(s)`);
    return templates;
  } catch (error) {
    logger.error('Error getting filter templates:', error);
    throw error;
  }
});

ipcMain.handle('save-filter-template', async (event, template: { name: string; code: string; description?: string; metadata?: any }) => {
  logger.info(`Saving filter template: ${template.name}`);
  try {
    await templateManager.saveTemplate(template);
    return { success: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Error saving filter template:', errorMsg);
    return { success: false, error: errorMsg };
  }
});

ipcMain.handle('delete-filter-template', async (event, name: string) => {
  logger.info(`Deleting filter template: ${name}`);
  try {
    await templateManager.deleteTemplate(name);
    return { success: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Error deleting filter template:', errorMsg);
    return { success: false, error: errorMsg };
  }
});

ipcMain.handle('read-template-file', async (event, filePath: string) => {
  logger.info(`Reading template file: ${filePath}`);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return { success: true, content };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Error reading template file:', errorMsg);
    return { success: false, error: errorMsg };
  }
});

ipcMain.handle('file-exists', async (event, filePath: string) => {
  logger.debug(`Checking if file exists: ${filePath}`);
  try {
    const exists = fs.existsSync(filePath);
    logger.debug(`File exists: ${exists}`);
    return exists;
  } catch (error) {
    logger.error('Error checking file existence:', error);
    return false;
  }
});

// ============================================================================
// WORKFLOW HANDLERS
// ============================================================================

ipcMain.handle('select-workflow-file', async (event, mode: 'open' | 'save') => {
  logger.info(`Selecting workflow file (mode: ${mode})`);
  try {
    if (mode === 'open') {
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [
          { name: 'Vapourkit Workflow', extensions: ['vkworkflow'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });
      return result.canceled ? null : result.filePaths[0];
    } else {
      const result = await dialog.showSaveDialog({
        filters: [
          { name: 'Vapourkit Workflow', extensions: ['vkworkflow'] },
          { name: 'All Files', extensions: ['*'] }
        ],
        defaultPath: 'My Workflow.vkworkflow'
      });
      return result.canceled ? null : result.filePath;
    }
  } catch (error) {
    logger.error('Error selecting workflow file:', error);
    return null;
  }
});

ipcMain.handle('export-workflow', async (event, workflow: any, filePath: string) => {
  logger.info(`Exporting workflow to: ${filePath}`);
  try {
    const toml = require('@iarna/toml');
    
    // Convert workflow to TOML format
    const tomlData = {
      workflow: {
        name: workflow.name,
        version: workflow.version,
        created_at: workflow.createdAt,
        description: workflow.description || '',
      },
      filters: workflow.filters.map((f: any) => ({
        name: f.name,
        code: f.code,
        description: f.description || '',
        enabled: f.enabled,
        order: f.order,
        filterType: f.filterType || 'custom',
        modelPath: f.modelPath || undefined,
        modelType: f.modelType || undefined,
      })),
    };

    const tomlString = toml.stringify(tomlData);
    await fs.writeFile(filePath, tomlString, 'utf-8');
    
    logger.info('Workflow exported successfully');
    return { success: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Error exporting workflow:', errorMsg);
    return { success: false, error: errorMsg };
  }
});

ipcMain.handle('import-workflow', async (event, filePath: string) => {
  logger.info(`Importing workflow from: ${filePath}`);
  try {
    const toml = require('@iarna/toml');
    
    const content = await fs.readFile(filePath, 'utf-8');
    const data = toml.parse(content);
    
    // Validate workflow structure
    if (!data.workflow || !data.filters) {
      throw new Error('Invalid workflow file format');
    }

    const workflow = {
      name: data.workflow.name,
      version: data.workflow.version,
      createdAt: data.workflow.created_at,
      description: data.workflow.description,
      filters: Array.isArray(data.filters) ? data.filters.map((f: any) => ({
        name: f.name,
        code: f.code,
        description: f.description || undefined,
        enabled: f.enabled,
        order: f.order,
        filterType: f.filterType || 'custom',
        modelPath: f.modelPath || undefined,
        modelType: f.modelType || undefined,
      })) : [],
    };

    logger.info(`Workflow imported successfully: ${workflow.name}`);
    return { success: true, workflow };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Error importing workflow:', errorMsg);
    return { success: false, error: errorMsg };
  }
});

// ============================================================================
// PLUGIN DEPENDENCY HANDLERS
// ============================================================================

ipcMain.handle('install-plugin-dependencies', async () => {
  logger.info('Installing plugin dependencies');
  try {
    const result = await pluginInstaller.installDependencies();
    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Error installing plugin dependencies:', errorMsg);
    return { success: false, error: errorMsg };
  }
});

ipcMain.handle('uninstall-plugin-dependencies', async () => {
  logger.info('Uninstalling plugin dependencies');
  try {
    const result = await pluginInstaller.uninstallDependencies();
    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Error uninstalling plugin dependencies:', errorMsg);
    return { success: false, error: errorMsg };
  }
});

ipcMain.handle('check-plugin-dependencies', async () => {
  logger.info('Checking plugin dependencies');
  try {
    const result = await pluginInstaller.checkInstalled();
    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Error checking plugin dependencies:', errorMsg);
    return { installed: false, packages: [] };
  }
});

ipcMain.handle('cancel-plugin-dependency-install', async () => {
  logger.info('Cancelling plugin dependency operation');
  pluginInstaller.cancel();
  return { success: true };
});

app.whenReady().then(() => {
  logger.info('App ready, registering protocols');
  
  protocol.registerFileProtocol('video', (request, callback) => {
    const url = request.url.replace('video://', '');
    const decodedPath = decodeURIComponent(url);
    logger.debug(`Video protocol request: ${decodedPath}`);
    callback({ path: decodedPath });
  });

  createWindow();
});

// Global error handler for main process
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
  dialog.showErrorBox('Error', error.message || 'An unknown error occurred');
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
  const message = reason instanceof Error ? reason.message : String(reason);
  dialog.showErrorBox('Error', message || 'An unknown error occurred');
});

app.on('window-all-closed', () => {
  logger.info('All windows closed');
  if (process.platform !== 'darwin') {
    logger.info('Quitting application');
    app.quit();
  }
});

app.on('activate', () => {
  logger.info('App activated');
  if (mainWindow === null) {
    createWindow();
  }
});