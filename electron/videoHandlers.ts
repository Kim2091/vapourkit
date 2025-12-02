import { ipcMain, BrowserWindow, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import { spawn } from 'child_process';
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
import { FFmpegManager } from './ffmpegManager';

let upscaleExecutor: UpscaleExecutor | null = null;
let previewExecutor: UpscaleExecutor | null = null;

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
        colorSpace: metadata.colorSpace,
        duration: metadata.duration
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
      
      // Warning: Reading large files into memory can cause the app to crash.
      // For playback, use the 'video://' protocol instead.
      if (stats.size > 500 * 1024 * 1024) {
         logger.warn(`Reading large file into memory: ${filePath} (${formatBytes(stats.size)})`);
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
    numStreams?: number,
    segment?: { enabled: boolean; startFrame: number; endFrame: number }
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
      
      // Log segment selection
      if (segment?.enabled) {
        logger.upscale(`Segment: frames ${segment.startFrame} to ${segment.endFrame === -1 ? 'end' : segment.endFrame}`);
      }
      
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
          numStreams,
          segment
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

        // Get video metadata for fps (needed for audio segment trimming)
        const videoMetadata = await extractVideoMetadata(videoPath);
        const fps = videoMetadata.fps || 24;
        logger.upscale(`Input video fps: ${fps}`);

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
        await upscaleExecutor.execute(scriptPath, outputPath, videoPath, totalFrames, false, segment?.enabled ? segment : undefined, fps);

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

  // Preview segment handler - processes a short segment and opens it in the default video player
  ipcMain.handle('preview-segment', async (
    event,
    videoPath: string,
    modelPath: string | null,
    useDirectML?: boolean,
    upscalingEnabled?: boolean,
    filters?: any[],
    numStreams?: number,
    startFrame?: number,
    endFrame?: number
  ) => {
    return await withLogSeparator(async () => {
      logger.upscale('Starting segment preview');
      logger.upscale(`Input: ${videoPath}`);
      logger.upscale(`Preview frames: ${startFrame ?? 0} to ${endFrame ?? 'auto'}`);
      
      try {
        // Create temporary preview output path
        const timestamp = Date.now();
        const previewPath = path.join(os.tmpdir(), `vapourkit_preview_${timestamp}.mkv`);
        
        // Create segment config for preview
        const previewSegment = {
          enabled: true,
          startFrame: startFrame ?? 0,
          endFrame: endFrame ?? -1
        };
        
        const config = createScriptConfig(
          videoPath,
          modelPath,
          dependencyManager,
          useDirectML,
          upscalingEnabled,
          filters,
          numStreams,
          previewSegment
        );
        
        const scriptPath = await scriptGenerator.generateScript(config);
        logger.upscale(`Preview script generated: ${scriptPath}`);
        
        // Get video metadata for fps (needed for audio segment trimming)
        const videoMetadata = await extractVideoMetadata(videoPath);
        const fps = videoMetadata.fps || 24;
        logger.upscale(`Input video fps: ${fps}`);
        
        // Initialize executor for preview
        const vspipePath = dependencyManager.getVSPipePath();
        const pythonPath = dependencyManager.getPythonExecutablePath();
        previewExecutor = new UpscaleExecutor(vspipePath, pythonPath, mainWindow);
        
        // Get frame count
        const totalFrames = await previewExecutor.getFrameCount(scriptPath);
        logger.upscale(`Preview frames to process: ${totalFrames}`);
        
        // Execute preview (previewMode=true to skip subtitles for MKV compatibility)
        await previewExecutor.execute(scriptPath, previewPath, videoPath, totalFrames, true, previewSegment, fps);
        
        // Cleanup script
        await scriptGenerator.cleanupScript(scriptPath);
        previewExecutor = null;
        
        logger.upscale('Preview completed successfully');
        return { success: true, previewPath };
      } catch (error) {
        previewExecutor = null;
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        logger.error('Preview failed:', errorMsg);
        return { success: false, error: errorMsg };
      }
    });
  });

  // Extract embedded thumbnail from video file
  ipcMain.handle('get-video-thumbnail', async (event, videoPath: string): Promise<string | null> => {
    try {
      const ffmpegPath = FFmpegManager.getFFmpegPath();
      if (!ffmpegPath) {
        logger.warn('FFmpeg not available for thumbnail extraction');
        return null;
      }

      // Check if video file exists
      if (!fs.existsSync(videoPath)) {
        logger.warn(`Video file not found for thumbnail: ${videoPath}`);
        return null;
      }

      // Create a hash of the video path for caching
      const crypto = require('crypto');
      const pathHash = crypto.createHash('md5').update(videoPath).digest('hex');
      const thumbnailDir = path.join(os.tmpdir(), 'vapourkit_thumbnails');
      const thumbnailPath = path.join(thumbnailDir, `${pathHash}.jpg`);

      // Check if thumbnail already exists in cache
      if (fs.existsSync(thumbnailPath)) {
        const thumbnailData = await fs.readFile(thumbnailPath);
        return `data:image/jpeg;base64,${thumbnailData.toString('base64')}`;
      }

      // Ensure thumbnail directory exists
      await fs.ensureDir(thumbnailDir);

      // Try to extract embedded thumbnail first (faster, uses existing thumbnail in file)
      const extractEmbedded = (): Promise<boolean> => {
        return new Promise((resolve) => {
          const proc = spawn(ffmpegPath, [
            '-i', videoPath,
            '-map', '0:v:0',      // First video stream (often the thumbnail)
            '-c:v', 'mjpeg',      // Output as JPEG
            '-frames:v', '1',     // Only one frame
            '-an',                // No audio
            '-y',                 // Overwrite
            thumbnailPath
          ], { stdio: ['ignore', 'pipe', 'pipe'] });

          let hasOutput = false;
          
          proc.on('close', async (code) => {
            // Check if file was created and has content
            if (code === 0 && fs.existsSync(thumbnailPath)) {
              const stats = await fs.stat(thumbnailPath);
              hasOutput = stats.size > 0;
            }
            resolve(hasOutput);
          });

          proc.on('error', () => resolve(false));
          
          // Timeout after 3 seconds
          setTimeout(() => {
            proc.kill();
            resolve(false);
          }, 3000);
        });
      };

      // Extract a frame from the video at 1 second mark as fallback
      const extractFrame = (): Promise<boolean> => {
        return new Promise((resolve) => {
          const proc = spawn(ffmpegPath, [
            '-ss', '1',           // Seek to 1 second
            '-i', videoPath,
            '-frames:v', '1',     // Only one frame
            '-vf', 'scale=320:-1', // Scale to 320px width, maintain aspect ratio
            '-q:v', '5',          // Quality (2-31, lower is better)
            '-y',                 // Overwrite
            thumbnailPath
          ], { stdio: ['ignore', 'pipe', 'pipe'] });

          proc.on('close', async (code) => {
            if (code === 0 && fs.existsSync(thumbnailPath)) {
              const stats = await fs.stat(thumbnailPath);
              resolve(stats.size > 0);
            } else {
              resolve(false);
            }
          });

          proc.on('error', () => resolve(false));
          
          // Timeout after 5 seconds
          setTimeout(() => {
            proc.kill();
            resolve(false);
          }, 5000);
        });
      };

      // Try embedded first, then fallback to extracting a frame
      let success = await extractEmbedded();
      if (!success) {
        success = await extractFrame();
      }

      if (success && fs.existsSync(thumbnailPath)) {
        const thumbnailData = await fs.readFile(thumbnailPath);
        return `data:image/jpeg;base64,${thumbnailData.toString('base64')}`;
      }

      return null;
    } catch (error) {
      logger.warn('Error extracting video thumbnail:', error);
      return null;
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
  numStreams?: number,
  segment?: { enabled: boolean; startFrame: number; endFrame: number }
) {
  const isUpscaling = upscalingEnabled !== false;
  
  let modelType: 'tspan' | 'image' = 'image';
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
  const processingFormat = configManager.getProcessingFormat();
  const outputFormat = processingFormat === 'match_input' ? 'original_clip.format.id' : processingFormat;
  
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
    numStreams: numStreams,
    outputFormat: outputFormat,
    segment: segment?.enabled ? segment : undefined
  };
}
