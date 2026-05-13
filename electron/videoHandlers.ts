import { ipcMain, BrowserWindow, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import { spawn } from 'child_process';
import { logger } from './logger';
import { PATHS } from './constants';
import { configManager } from './configManager';
import { withLogSeparator } from './utils';
import { extractVideoMetadata, getVideoFrameCount } from './videoUtils';
import { formatBytes } from './ipcUtilities';
import { handleValidated } from './ipcValidation';
import { z } from 'zod';
import { VapourSynthScriptGenerator } from './scriptGenerator';
import { UpscaleExecutor } from './upscaleExecutor';
import { DependencyManager } from './dependencyManager';
import { FFmpegSettingsManager } from './ffmpegSettingsManager';
import { FFmpegManager } from './ffmpegManager';
import { VsViewManager } from './vsViewManager';
import { QueueItemLogger } from './queueItemLogger';

let upscaleExecutor: UpscaleExecutor | null = null;
let previewExecutor: UpscaleExecutor | null = null;
let infoExecutor: UpscaleExecutor | null = null;
let activeQueueItemLogger: QueueItemLogger | null = null;

/**
 * Cancels all active video processing executors and their child processes
 */
export function cancelAllVideoProcessing(): void {
  if (activeQueueItemLogger) {
    activeQueueItemLogger.write('Processing canceled (app shutdown)');
    activeQueueItemLogger.close();
    activeQueueItemLogger = null;
  }
  if (upscaleExecutor) {
    upscaleExecutor.cancelInfoExtraction();
    upscaleExecutor.kill();
    upscaleExecutor = null;
  }
  if (previewExecutor) {
    previewExecutor.cancelInfoExtraction();
    previewExecutor.kill();
    previewExecutor = null;
  }
  if (infoExecutor) {
    infoExecutor.cancelInfoExtraction();
    infoExecutor = null;
  }
}

/**
 * Registers all video-related IPC handlers
 */
export function registerVideoHandlers(
  mainWindow: BrowserWindow | null,
  scriptGenerator: VapourSynthScriptGenerator,
  dependencyManager: DependencyManager
) {
  handleValidated('get-video-info', z.string().min(1), async (filePath) => {
    logger.info(`Getting video info for: ${filePath}`);
    try {
      const stats = await fs.stat(filePath);
      const metadata = await extractVideoMetadata(filePath);

      // Stream BestSource indexing progress to the renderer
      const onProgress = (percentage: number) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('video-index-progress', { percentage, complete: false });
        }
      };

      let frameCount: number | undefined;
      try {
        frameCount = await getVideoFrameCount(filePath, onProgress);
      } finally {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('video-index-progress', { percentage: 100, complete: true });
        }
      }

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
        duration: metadata.duration,
        frameCount: frameCount
      };

      logger.info(`Video info: ${info.name}, ${info.sizeFormatted}, ${metadata.resolution || 'unknown resolution'}, ${metadata.fps ? metadata.fps + ' fps' : 'unknown fps'}, ${metadata.pixelFormat || 'unknown format'}${frameCount ? `, ${frameCount} frames` : ''}`);
      return info;
    } catch (error) {
      logger.error('Error getting video info:', error);
      // Inner finally already sent the terminal event if frame counting started.
      // Earlier failures (stat/metadata) happen before the renderer shows any
      // progress UI, so no terminal event is required.
      throw error;
    }
  });

  handleValidated('read-video-file', z.string().min(1), async (filePath) => {
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
    numStreams?: number,
    sourceFps?: number
  ) => {
    logger.info(`Getting output info for: ${videoPath} (validation mode - first 5 seconds)`);
    try {
      // Cancel any previous info extraction
      if (infoExecutor) {
        infoExecutor.cancelInfoExtraction();
        infoExecutor = null;
      }
      
      const config = createScriptConfig(
        videoPath,
        modelPath,
        dependencyManager,
        useDirectML,
        upscalingEnabled,
        filters,
        numStreams,
        undefined, // segment
        true, // validationMode - always enabled for get-output-resolution
        sourceFps
      );
      
      const scriptPath = await scriptGenerator.generateScript(config);
      
      const vspipePath = dependencyManager.getVSPipePath();
      const pythonPath = dependencyManager.getPythonExecutablePath();
      infoExecutor = new UpscaleExecutor(vspipePath, pythonPath, null);
      
      const info = await infoExecutor.getOutputInfo(scriptPath);
      infoExecutor = null;
      
      // Check if vspipe returned an error
      if (info.error) {
        await scriptGenerator.cleanupScript(scriptPath);
        logger.error('Workflow validation error:', info.error);
        return { resolution: null, fps: null, error: info.error };
      }
      
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
          else {
              // Extract codec name directly from -c:v for custom/unknown codecs
              const codecMatch = args.match(/-c:v\s+(\S+)/);
              if (codecMatch) codec = codecMatch[1].toUpperCase();
          }
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
      infoExecutor = null;
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('Error getting output info:', errorMsg);
      return { resolution: null, fps: null, error: errorMsg };
    }
  });

  // Cancel validation handler
  ipcMain.handle('cancel-validation', async () => {
    logger.info('Cancelling workflow validation');
    if (infoExecutor) {
      infoExecutor.cancelInfoExtraction();
      infoExecutor = null;
    }
    return { success: true, cancelled: true };
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
    segment?: { enabled: boolean; startFrame: number; endFrame: number },
    benchmarkMode?: boolean
  ) => {
    return await withLogSeparator(async () => {
      const isUpscaling = upscalingEnabled !== false; // Default to true for backward compatibility
      
      // Close any previous queue item logger
      if (activeQueueItemLogger) {
        activeQueueItemLogger.close();
        activeQueueItemLogger = null;
      }

      // Create per-item log file for this processing run
      const videoName = videoPath.split(/[\\/]/).pop() || 'unknown';
      const itemLogger = new QueueItemLogger(videoName);
      await itemLogger.open();
      activeQueueItemLogger = itemLogger;

      // Helper to log to both main log and per-item log
      const qlog = (message: string) => {
        logger.upscale(message);
        itemLogger.write(message);
      };
      const qerror = (message: string) => {
        logger.error(message);
        itemLogger.error(message);
      };

      // Cancel any pending upscale/preview/info executors and their child processes
      if (infoExecutor) {
        qlog('Canceling info executor before starting new processing');
        infoExecutor.cancelInfoExtraction();
        infoExecutor = null;
      }
      if (upscaleExecutor) {
        qlog('Canceling previous upscale executor before starting new processing');
        upscaleExecutor.cancelInfoExtraction();
        upscaleExecutor.kill();
        upscaleExecutor = null;
      }
      if (previewExecutor) {
        qlog('Canceling previous preview executor before starting new processing');
        previewExecutor.cancelInfoExtraction();
        previewExecutor.kill();
        previewExecutor = null;
      }
      
      qlog('Starting processing');
      qlog(`Input: ${videoPath}`);
      qlog(`Upscaling: ${isUpscaling ? 'enabled' : 'disabled'}`);
      if (isUpscaling && modelPath) {
        qlog(`Model: ${modelPath}`);
        qlog(`Backend: ${useDirectML ? 'DirectML (ONNX Runtime)' : 'TensorRT'}`);
      }
      qlog(`Output: ${benchmarkMode ? '(benchmark - null output)' : outputPath}`);
      if (benchmarkMode) qlog('BENCHMARK MODE: Output will be discarded');
      qlog(`Item log: ${itemLogger.getLogPath()}`);
      
      // Log segment selection
      if (segment?.enabled) {
        qlog(`Segment: frames ${segment.startFrame} to ${segment.endFrame === -1 ? 'end' : segment.endFrame}`);
      }
      
      // Log filter status
      if (filters && filters.length > 0) {
        const enabledFilters = filters.filter(f => f.enabled);
        qlog(`Filters: ${enabledFilters.length} enabled`);
        enabledFilters.forEach(f => {
          itemLogger.write(`  Filter: ${f.templateName || f.id} (enabled)`);
        });
      }
      
      try {
        // Generate VapourSynth script
        qlog('Generating VapourSynth script');
        
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
          qlog(`Model type: ${config.modelType}`);
        }

        const scriptPath = await scriptGenerator.generateScript(config);
        qlog(`Script generated: ${scriptPath}`);

        // Log script content to per-item log for troubleshooting
        try {
          const scriptContent = await fs.readFile(scriptPath, 'utf-8');
          itemLogger.write('=== VapourSynth Script Content ===');
          itemLogger.write(scriptContent);
          itemLogger.write('=== End Script Content ===');
        } catch { /* ignore read errors */ }

        // Get video metadata for fps (needed for audio segment trimming)
        const videoMetadata = await extractVideoMetadata(videoPath);
        const fps = videoMetadata.fps || 24;
        qlog(`Input video fps: ${fps}`);

        // Initialize executor
        const vspipePath = dependencyManager.getVSPipePath();
        const pythonPath = dependencyManager.getPythonExecutablePath();
        qlog(`VSPipe: ${vspipePath}`);
        qlog(`Python: ${pythonPath}`);
        
        const executor = new UpscaleExecutor(vspipePath, pythonPath, mainWindow);
        upscaleExecutor = executor;

        // Get frame count and execute. Stream BestSource indexing progress so a
        // cold cache doesn't look like a hang, and re-check the module slot after
        // the await — cancel-upscale, kill-upscale, and the new-run cleanup at the
        // top of this handler all null the module reference mid-flight.
        qlog('Getting frame count');
        let lastIndexPct = -1;
        const totalFrames = await executor.getFrameCount(scriptPath, (pct) => {
          if (pct !== lastIndexPct) {
            lastIndexPct = pct;
            qlog(`Indexing source: ${pct}%`);
          }
          mainWindow?.webContents.send('video-index-progress', { percentage: pct, complete: false });
        });
        qlog(`Total frames to process: ${totalFrames}`);

        if (upscaleExecutor !== executor) {
          qlog('Upscale canceled before execution started');
          mainWindow?.webContents.send('video-index-progress', { percentage: 100, complete: true });
          itemLogger.close();
          activeQueueItemLogger = null;
          return { success: false, error: 'Canceled' };
        }
        mainWindow?.webContents.send('video-index-progress', { percentage: 100, complete: true });

        qlog('Starting execution');
        await executor.execute(scriptPath, outputPath, videoPath, totalFrames, false, segment?.enabled ? segment : undefined, fps, benchmarkMode);

        // Cleanup
        qlog('Cleaning up script file');
        await scriptGenerator.cleanupScript(scriptPath);

        qlog('Processing completed successfully');
        itemLogger.close();
        activeQueueItemLogger = null;
        return { success: true, outputPath };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        qerror(`Processing failed: ${errorMsg}`);
        itemLogger.close();
        activeQueueItemLogger = null;
        return { success: false, error: errorMsg };
      }
    });
  });

  ipcMain.handle('cancel-upscale', async () => {
    logger.upscale('Canceling upscale process');
    if (activeQueueItemLogger) {
      activeQueueItemLogger.write('Processing canceled by user');
      activeQueueItemLogger.close();
      activeQueueItemLogger = null;
    }
    if (upscaleExecutor) {
      upscaleExecutor.cancel();
      upscaleExecutor = null;
      logger.upscale('Upscale canceled');
    }
    return { success: true };
  });

  ipcMain.handle('kill-upscale', async () => {
    logger.upscale('Force killing upscale process');
    if (activeQueueItemLogger) {
      activeQueueItemLogger.write('Processing force killed');
      activeQueueItemLogger.close();
      activeQueueItemLogger = null;
    }
    if (upscaleExecutor) {
      upscaleExecutor.kill();
      upscaleExecutor = null;
      logger.upscale('Upscale force killed');
    }
    return { success: true };
  });

  handleValidated('compare-videos', z.tuple([z.string().min(1), z.string().min(1)]), async ([inputPath, outputPath]) => {
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
      
      // Get custom args from config
      const videoCompareArgsString = configManager.getVideoCompareArgs();
      const customArgs = videoCompareArgsString.trim().split(/\s+/).filter(arg => arg.length > 0);
      
      // Combine args with video paths
      const allArgs = [...customArgs, inputPath, outputPath];
      logger.info(`Video compare args: ${allArgs.join(' ')}`);
      
      const child = spawn(PATHS.VIDEO_COMPARE_EXE, allArgs, {
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

  // Launch vs-view with a VapourSynth script
  ipcMain.handle('launch-vse-previewer', async (
    event,
    videoPath: string,
    modelPath: string | null,
    useDirectML?: boolean,
    upscalingEnabled?: boolean,
    filters?: any[],
    numStreams?: number,
    segment?: { enabled: boolean; startFrame: number; endFrame: number }
  ) => {
    logger.info(`Launching vs-view for video: ${videoPath}`);
    try {
      // Generate VapourSynth script with the current workflow
      const metadata = await extractVideoMetadata(videoPath);
      
      const scriptConfig = {
        inputVideo: videoPath,
        enginePath: PATHS.MLRT_PLUGIN,
        pluginsPath: PATHS.PLUGINS,
        useDirectML: useDirectML || false,
        useFp32: modelPath ? configManager.isModelFp32(modelPath) : false,
        modelType: modelPath ? configManager.getModelType(modelPath) : 'image' as const,
        upscalingEnabled: upscalingEnabled || false,
        colorimetry: configManager.getColorimetrySettings(),
        filters: filters || [],
        numStreams: numStreams || 2,
        outputFormat: 'vs.YUV420P8',
        segment: segment,
        sourceFps: metadata.fps,
        generatePreviewOutputs: true // Enable multi-output generation for filter comparison
      };

      const scriptPath = await scriptGenerator.generateScript(scriptConfig);
      logger.info(`Generated preview script: ${scriptPath}`);

      // Launch vs-view with the generated script
      const result = await VsViewManager.launch(scriptPath);
      
      if (result.success) {
        logger.info('vs-view launched successfully');
      } else {
        logger.error(`Failed to launch vs-view: ${result.error}`);
      }

      return result;
    } catch (error) {
      logger.error('Error launching vs-view:', error);
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
      
      // Cancel any pending info extraction or previous preview
      if (infoExecutor) {
        infoExecutor.cancelInfoExtraction();
        infoExecutor = null;
      }
      if (previewExecutor) {
        logger.upscale('Canceling previous preview executor');
        previewExecutor.cancelInfoExtraction();
        previewExecutor.kill();
        previewExecutor = null;
      }
      
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
        const executor = new UpscaleExecutor(vspipePath, pythonPath, mainWindow);
        previewExecutor = executor;

        // Stream indexing progress and re-check the module slot before executing —
        // start-upscale and a subsequent preview-segment both null the previous
        // previewExecutor mid-flight.
        let lastIndexPct = -1;
        const totalFrames = await executor.getFrameCount(scriptPath, (pct) => {
          if (pct !== lastIndexPct) {
            lastIndexPct = pct;
            logger.upscale(`Preview indexing source: ${pct}%`);
          }
          mainWindow?.webContents.send('video-index-progress', { percentage: pct, complete: false });
        });
        logger.upscale(`Preview frames to process: ${totalFrames}`);

        if (previewExecutor !== executor) {
          logger.upscale('Preview canceled before execution started');
          mainWindow?.webContents.send('video-index-progress', { percentage: 100, complete: true });
          return { success: false, error: 'Canceled' };
        }
        mainWindow?.webContents.send('video-index-progress', { percentage: 100, complete: true });

        // Execute preview (previewMode=true to skip subtitles for MKV compatibility)
        await executor.execute(scriptPath, previewPath, videoPath, totalFrames, true, previewSegment, fps);
        
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

  // Extract a frame at a specific frame number from video
  ipcMain.handle('get-video-frame-at', async (
    event, 
    videoPath: string, 
    frameNumber: number, 
    fps: number
  ): Promise<string | null> => {
    try {
      const ffmpegPath = FFmpegManager.getFFmpegPath();
      if (!ffmpegPath) {
        logger.warn('FFmpeg not available for frame extraction');
        return null;
      }

      // Check if video file exists
      if (!fs.existsSync(videoPath)) {
        logger.warn(`Video file not found for frame extraction: ${videoPath}`);
        return null;
      }

      // Calculate timestamp from frame number and fps
      const timestamp = frameNumber / (fps || 24);
      
      // Create a unique temp file for this frame
      const crypto = require('crypto');
      const frameHash = crypto.createHash('md5').update(`${videoPath}-${frameNumber}`).digest('hex');
      const frameDir = path.join(os.tmpdir(), 'vapourkit_frames');
      const framePath = path.join(frameDir, `${frameHash}.jpg`);

      // Ensure frame directory exists
      await fs.ensureDir(frameDir);

      // Extract frame using ffmpeg with fast seeking
      return new Promise((resolve) => {
        const proc = spawn(ffmpegPath, [
          '-ss', timestamp.toFixed(3),  // Seek to timestamp (fast seek before input)
          '-i', videoPath,
          '-frames:v', '1',             // Only one frame
          '-vf', 'scale=640:-1',        // Scale to 640px width, maintain aspect ratio
          '-q:v', '3',                  // Quality (2-31, lower is better)
          '-y',                         // Overwrite
          framePath
        ], { stdio: ['ignore', 'pipe', 'pipe'] });

        proc.on('close', async (code) => {
          if (code === 0 && fs.existsSync(framePath)) {
            try {
              const frameData = await fs.readFile(framePath);
              // Clean up temp file
              await fs.remove(framePath).catch(() => {});
              resolve(`data:image/jpeg;base64,${frameData.toString('base64')}`);
            } catch (err) {
              resolve(null);
            }
          } else {
            resolve(null);
          }
        });

        proc.on('error', () => resolve(null));
        
        // Timeout after 5 seconds
        setTimeout(() => {
          proc.kill();
          resolve(null);
        }, 5000);
      });
    } catch (error) {
      logger.warn('Error extracting video frame:', error);
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
  segment?: { enabled: boolean; startFrame: number; endFrame: number },
  validationMode?: boolean,
  sourceFps?: number
) {
  const isUpscaling = upscalingEnabled !== false;
  
  let modelType: 'vsr' | 'image' = 'image';
  let useFp32 = false;
  
  if (isUpscaling && modelPath) {
    modelType = configManager.getModelType(modelPath);
    useFp32 = configManager.isModelFp32(modelPath);
  }

  const colorimetrySettings = configManager.getColorimetrySettings();
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
    colorimetry: colorimetrySettings,
    filters: filters,
    numStreams: numStreams,
    outputFormat: outputFormat,
    segment: segment?.enabled ? segment : undefined,
    validationMode: validationMode,
    sourceFps: sourceFps
  };
}
