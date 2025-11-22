import { ipcMain, BrowserWindow, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs-extra';
import { logger } from './logger';
import { PATHS } from './constants';
import { configManager } from './configManager';
import { withLogSeparator } from './utils';
import { extractVideoMetadata } from './videoUtils';
import { formatBytes } from './ipcUtilities';
import { VapourSynthScriptGenerator } from './scriptGenerator';
import { UpscaleExecutor } from './upscaleExecutor';
import { DependencyManager } from './dependencyManager';
import { FFmpegSettingsManager } from './ffmpegSettingsManager';

let upscaleExecutor: UpscaleExecutor | null = null;

/**
 * Registers all video-related IPC handlers
 */
export function registerVideoHandlers(
  mainWindow: BrowserWindow | null,
  scriptGenerator: VapourSynthScriptGenerator,
  dependencyManager: DependencyManager
) {
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
        pixelFormat: metadata.pixelFormat,
        codec: metadata.codec,
        container: metadata.container,
        scanType: metadata.scanType,
        colorSpace: metadata.colorSpace
      };
      
      logger.info(`Video info: ${info.name}, ${info.sizeFormatted}, ${metadata.resolution || 'unknown resolution'}, ${metadata.fps ? metadata.fps + ' fps' : 'unknown fps'}, ${metadata.pixelFormat || 'unknown format'}`);
      return info;
    } catch (error) {
      logger.error('Error getting video info:', error);
      throw error;
    }
  });

  ipcMain.handle('read-video-file', async (event, filePath: string) => {
    try {
      // Check file size first to prevent loading massive files into memory
      const stats = await fs.stat(filePath);
      const MAX_SIZE = 100 * 1024 * 1024; // 100MB limit for preview
      
      if (stats.size > MAX_SIZE) {
        throw new Error(`File too large for preview (${formatBytes(stats.size)}). Max size is ${formatBytes(MAX_SIZE)}.`);
      }
      
      return await fs.readFile(filePath);
    } catch (error) {
      logger.error('Error reading video file:', error);
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
      const config = createScriptConfig(
        videoPath,
        modelPath,
        dependencyManager,
        useDirectML,
        upscalingEnabled,
        filters,
        numStreams
      );
      
      const scriptPath = await scriptGenerator.generateScript(config);
      
      const vspipePath = dependencyManager.getVSPipePath();
      const pythonPath = dependencyManager.getPythonExecutablePath();
      const tempExecutor = new UpscaleExecutor(vspipePath, pythonPath, null);
      
      const info = await tempExecutor.getOutputInfo(scriptPath);
      
      // Get codec from settings
      const ffmpegConfig = await FFmpegSettingsManager.loadFFmpegConfig(configManager);
      // Infer codec from videoArgs or default
      let codec = 'H.264'; // Default assumption if not specified
      if (ffmpegConfig.videoArgs) {
          const args = ffmpegConfig.videoArgs.join(' ');
          if (args.includes('libx265') || args.includes('hevc')) codec = 'H.265 (HEVC)';
          else if (args.includes('libx264')) codec = 'H.264 (AVC)';
          else if (args.includes('prores')) codec = 'ProRes';
          else if (args.includes('vp9')) codec = 'VP9';
          else if (args.includes('av1')) codec = 'AV1';
      }

      await scriptGenerator.cleanupScript(scriptPath);
      
      return {
        resolution: info.resolution,
        fps: info.fps,
        pixelFormat: info.pixelFormat,
        codec: codec,
        scanType: 'Progressive' // AI upscaling output is typically progressive
      };
    } catch (error) {
      logger.error('Error getting output info:', error);
      return { resolution: null, fps: null };
    }
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
        
        const config = createScriptConfig(
          videoPath,
          modelPath,
          dependencyManager,
          useDirectML,
          upscalingEnabled,
          filters,
          numStreams
        );

        if (config.upscalingEnabled && config.enginePath) {
          logger.upscale(`Model type: ${config.modelType}`);
        }
        
        // Log if simple mode default filter was created
        if (config.filters && config.filters.length === 1 && config.filters[0].id === 'default-upscale') {
          logger.upscale('Simple mode: Created default upscale filter');
        }
        
        const scriptPath = await scriptGenerator.generateScript(config);
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

  ipcMain.handle('kill-upscale', async () => {
    logger.upscale('Force killing upscale process');
    if (upscaleExecutor) {
      upscaleExecutor.kill();
      upscaleExecutor = null;
      logger.upscale('Upscale force killed');
    }
    return { success: true };
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
}

/**
 * Helper to create script configuration
 */
function createScriptConfig(
  videoPath: string,
  modelPath: string | null,
  dependencyManager: DependencyManager,
  useDirectML?: boolean,
  upscalingEnabled?: boolean,
  filters?: any[],
  numStreams?: number
) {
  const isUpscaling = upscalingEnabled !== false;
  
  let modelType: 'tspan' | 'image' = 'tspan';
  let useFp32 = false;
  
  if (isUpscaling && modelPath) {
    modelType = configManager.getModelType(modelPath);
    useFp32 = configManager.isModelFp32(modelPath);
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
  }
  
  const colorMatrixSettings = configManager.getColorMatrixSettings();
  
  return {
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
  };
}
