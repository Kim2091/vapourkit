// electron/upscaleExecutor.ts
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs-extra';
import { BrowserWindow } from 'electron';
import { logger } from './logger';
import { PATHS } from './constants';
import { setupVSEnvironment } from './utils';
import { FFmpegManager } from './ffmpegManager';
import { ErrorMessageHandler } from './errorMessageHandler';
import { VideoMetadataExtractor, VideoMetadata } from './videoMetadataExtractor';
import { VapourSynthInfoExtractor, OutputInfo } from './vapourSynthInfoExtractor';
import { FFmpegSettingsManager, FFmpegConfig } from './ffmpegSettingsManager';
import { configManager } from './configManager';

export interface UpscaleProgress {
  type: 'progress' | 'complete' | 'error' | 'preview-frame';
  currentFrame: number;
  totalFrames: number;
  fps: number;
  percentage: number;
  message: string;
  previewFrame?: string; // Base64 encoded PNG
  isStopping?: boolean; // Indicates if the process is stopping
}

export class UpscaleExecutor {
  private mainWindow: BrowserWindow | null;
  private vspipePath: string;
  private pythonPath: string;
  private vsPath: string;
  private process: ChildProcess | null = null;
  private ffmpegProcess: ChildProcess | null = null;
  private vsInfoExtractor: VapourSynthInfoExtractor;
  private isCanceling: boolean = false;

  constructor(vspipePath: string, pythonPath: string, mainWindow: BrowserWindow | null = null) {
    this.vspipePath = vspipePath;
    this.pythonPath = pythonPath;
    this.mainWindow = mainWindow;
    this.vsPath = path.dirname(vspipePath);
    this.vsInfoExtractor = new VapourSynthInfoExtractor(vspipePath, pythonPath, this.vsPath);
    
    logger.upscale(`Initialized UpscaleExecutor`);
    logger.upscale(`VSPipe: ${this.vspipePath}`);
    logger.upscale(`Python: ${this.pythonPath}`);
    logger.upscale(`Plugins: ${PATHS.PLUGINS}`);
  }


  private sendProgress(progress: UpscaleProgress) {
    if (this.mainWindow) {
      this.mainWindow.webContents.send('upscale-progress', progress);
      
      // Show error dialog for error progress
      if (progress.type === 'error') {
        const { dialog } = require('electron');
        dialog.showErrorBox('Upscale Error', progress.message);
      }
    }
  }





  async getFrameCount(scriptPath: string): Promise<number> {
    return this.vsInfoExtractor.getFrameCount(scriptPath);
  }

  async getOutputInfo(scriptPath: string): Promise<OutputInfo> {
    return this.vsInfoExtractor.getOutputInfo(scriptPath);
  }

  async execute(scriptPath: string, outputPath: string, inputPath: string, totalFrames: number = 0): Promise<void> {
    return new Promise(async (resolve, reject) => {
      logger.separator();
      logger.upscale('Starting upscale execution');
      logger.upscale(`Script: ${scriptPath}`);
      logger.upscale(`Input: ${inputPath}`);
      logger.upscale(`Output: ${outputPath}`);
      logger.upscale(`Total frames: ${totalFrames}`);
      
      // Validate script exists
      if (!await fs.pathExists(scriptPath)) {
        const error = `Script file not found: ${scriptPath}`;
        logger.errorWithDialog('Upscale Error', error);
        reject(new Error(error));
        return;
      }

      // Validate input exists
      if (!await fs.pathExists(inputPath)) {
        const error = `Input file not found: ${inputPath}`;
        logger.errorWithDialog('Upscale Error', error);
        reject(new Error(error));
        return;
      }

      // Validate video for upscaling compatibility
      const validation = await VideoMetadataExtractor.validateVideoForUpscaling(inputPath);
      if (!validation.valid) {
        logger.errorWithDialog('Upscale Error', validation.error || 'Video validation failed');
        reject(new Error(validation.error || 'Video validation failed'));
        return;
      }

      // Get metadata from input
      let metadata: VideoMetadata;
      try {
        metadata = await VideoMetadataExtractor.getVideoMetadata(inputPath);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.errorWithDialog('Upscale Error', 'Failed to get video metadata: ' + errorMsg);
        reject(error);
        return;
      }

      // Log script content for debugging
      logger.upscale('=== VapourSynth Script Content ===');
      const scriptContent = await fs.readFile(scriptPath, 'utf-8');
      logger.upscale(scriptContent);
      logger.upscale('=== End Script Content ===');

      // Setup VapourSynth environment
      const env = setupVSEnvironment(this.pythonPath);

      // Log environment for debugging
      logger.upscale('=== VapourSynth Environment ===');
      logger.upscale(`vspipe path: ${this.vspipePath}`);
      logger.upscale(`Python path: ${this.pythonPath}`);
      logger.upscale(`VS path: ${this.vsPath}`);
      logger.upscale(`Plugins path: ${PATHS.PLUGINS}`);
      logger.upscale(`VS_PLUGINS_PATH: ${env['VS_PLUGINS_PATH']}`);
      logger.upscale(`PYTHONHOME: ${env['PYTHONHOME']}`);
      logger.upscale(`PYTHONPATH: ${env['PYTHONPATH']}`);
      logger.upscale(`Working directory: ${this.vsPath}`);
      logger.upscale('=== End Environment ===');

      // Check if vspipe exists
      if (!await fs.pathExists(this.vspipePath)) {
        const error = `vspipe not found at: ${this.vspipePath}`;
        logger.errorWithDialog('Upscale Error', error);
        reject(new Error(error));
        return;
      }

      // Check if embedded Python exists
      if (!await fs.pathExists(this.pythonPath)) {
        const error = `Embedded Python not found at: ${this.pythonPath}`;
        logger.errorWithDialog('Upscale Error', error);
        reject(new Error(error));
        return;
      }
      
      // Check if ffmpeg exists
      const ffmpegPath = FFmpegManager.getFFmpegPath();
      if (!ffmpegPath || !await fs.pathExists(ffmpegPath)) {
        const error = `ffmpeg not found at: ${ffmpegPath || 'unknown'}`;
        logger.errorWithDialog('Upscale Error', error);
        reject(new Error(error));
        return;
      }

      // vspipe outputs Y4M directly
      logger.upscale('Spawning vspipe process');
      const vspipe = spawn(this.vspipePath, ['-c', 'y4m', scriptPath, '-'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: env,
        cwd: this.vsPath
      });

      // Build FFmpeg command with audio/subtitle passthrough AND preview output
      logger.upscale('Building FFmpeg command with metadata passthrough and preview output');
      const ffmpegConfig = await FFmpegSettingsManager.loadFFmpegConfig(configManager);
      const ffmpegArgs: string[] = [
        '-f', 'yuv4mpegpipe',
        '-i', 'pipe:0',
        '-i', inputPath
      ];

      // Main output: video file with audio/subs
      // Map video from pipe
      ffmpegArgs.push('-map', '0:v:0');

      // Map all audio streams from input
      if (metadata.hasAudio) {
        logger.upscale(`Mapping ${metadata.audioStreams} audio stream(s)`);
        ffmpegArgs.push('-map', '1:a?');
        ffmpegArgs.push('-c:a', 'copy');
      }

      // Map all subtitle streams from input
      if (metadata.hasSubtitles) {
        logger.upscale(`Mapping ${metadata.subtitleStreams} subtitle stream(s)`);
        ffmpegArgs.push('-map', '1:s?');
        ffmpegArgs.push('-c:s', 'copy');
      }

      // Add video encoding settings
      if (ffmpegConfig.videoArgs) {
        ffmpegArgs.push(...ffmpegConfig.videoArgs);
      }

      // Set DAR if available and enabled in config
      if (ffmpegConfig.preserveAspectRatio && metadata.dar) {
        logger.upscale(`Setting DAR: ${metadata.dar}`);
        ffmpegArgs.push('-aspect', metadata.dar);
      }

      // Copy metadata if enabled in config
      if (ffmpegConfig.copyMetadata) {
        logger.upscale('Copying metadata from input');
        ffmpegArgs.push('-map_metadata', '1');
      }

      // Add movflags if specified in config
      if (ffmpegConfig.movflags && ffmpegConfig.movflags.length > 0) {
        logger.upscale(`Adding movflags: ${ffmpegConfig.movflags.join(',')}`);
        ffmpegArgs.push('-movflags', ffmpegConfig.movflags.join(','));
      }

      // Main output file
      ffmpegArgs.push('-y', outputPath);

      // Preview output: PNG frames to stdout
      ffmpegArgs.push('-map', '0:v:0');
      ffmpegArgs.push('-vf', 'fps=1,scale=-2:720'); // 1 fps preview, max height 720p
      ffmpegArgs.push('-f', 'image2pipe');
      ffmpegArgs.push('-c:v', 'png');
      ffmpegArgs.push('pipe:1');

      logger.upscale(`FFmpeg command: ${ffmpegPath} ${ffmpegArgs.join(' ')}`);

      // Single FFmpeg process for both encoding and preview
      logger.upscale('Spawning single ffmpeg process for encoding and preview');
      const ffmpeg = spawn(ffmpegPath, ffmpegArgs, {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      
      // Store ffmpeg process reference for cancellation
      this.ffmpegProcess = ffmpeg;

      // Set binary encoding and add error handler
      if (ffmpeg.stdin) {
        ffmpeg.stdin.setDefaultEncoding('binary');
        ffmpeg.stdin.on('error', (err) => {
          // Suppress expected errors during cancellation
          if (!this.isCanceling) {
            logger.error('FFmpeg stdin error:', err);
          }
        });
      }

      // Pipe vspipe output directly to ffmpeg
      if (vspipe.stdout && ffmpeg.stdin) {
        vspipe.stdout.pipe(ffmpeg.stdin);
        
        vspipe.stdout.on('error', (error) => {
          logger.error('vspipe stdout error:', error);
        });
      }

      let currentFrame = 0;
      let currentFPS = 0;
      let vspipeStderrBuffer = '';
      let ffmpegStderrBuffer = '';
      const MAX_STDERR_BUFFER_SIZE = 1024 * 1024; // 1MB max per stderr buffer
      let previewFrameBuffer = Buffer.alloc(0);
      const MAX_PREVIEW_BUFFER_SIZE = 5 * 1024 * 1024; // 5MB max buffer
      let lastPreviewSentTime = 0;
      const MIN_PREVIEW_INTERVAL_MS = 500; // Throttle to max 2 previews per second

      // Capture preview frames from ffmpeg stdout
      if (ffmpeg.stdout) {
        ffmpeg.stdout.on('data', (data: Buffer) => {
          // Prevent memory overflow: if buffer is too large, drop incoming data
          if (previewFrameBuffer.length > MAX_PREVIEW_BUFFER_SIZE) {
            logger.warn(`Preview buffer overflow (${previewFrameBuffer.length} bytes), dropping frames`);
            previewFrameBuffer = Buffer.alloc(0); // Clear buffer to prevent crash
            return;
          }
          
          previewFrameBuffer = Buffer.concat([previewFrameBuffer, data]);
          
          // PNG starts with signature: 89 50 4E 47 0D 0A 1A 0A
          // PNG ends with IEND chunk: 49 45 4E 44 AE 42 60 82
          const startMarker = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
          const endMarker = Buffer.from([0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);
          
          let startIdx = previewFrameBuffer.indexOf(startMarker);
          let endIdx = previewFrameBuffer.indexOf(endMarker);
          
          while (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
            const pngFrame = previewFrameBuffer.slice(startIdx, endIdx + 8);
            
            // Throttle preview sending to prevent overwhelming the renderer
            const now = Date.now();
            if (now - lastPreviewSentTime >= MIN_PREVIEW_INTERVAL_MS) {
              const base64Frame = pngFrame.toString('base64');
              
              // Send preview frame
              this.sendProgress({
                type: 'preview-frame',
                currentFrame,
                totalFrames,
                fps: currentFPS,
                percentage: totalFrames > 0 ? Math.round((currentFrame / totalFrames) * 100) : 0,
                message: '',
                previewFrame: base64Frame
              });
              
              lastPreviewSentTime = now;
            }
            
            // Remove processed frame from buffer
            previewFrameBuffer = previewFrameBuffer.slice(endIdx + 8);
            startIdx = previewFrameBuffer.indexOf(startMarker);
            endIdx = previewFrameBuffer.indexOf(endMarker);
          }
        });
      }

      // Monitor vspipe stderr
      if (vspipe.stderr) {
        vspipe.stderr.on('data', (data: Buffer) => {
          const output = data.toString();
          // Prevent unbounded stderr buffer growth
          if (vspipeStderrBuffer.length < MAX_STDERR_BUFFER_SIZE) {
            vspipeStderrBuffer += output;
          } else if (vspipeStderrBuffer.length === MAX_STDERR_BUFFER_SIZE) {
            vspipeStderrBuffer += '\n... (stderr buffer limit reached, truncating further output) ...';
          }
          logger.error(`[vspipe stderr] ${output.trim()}`);
        });
      }

      // Monitor ffmpeg stderr for progress
      if (ffmpeg.stderr) {
        ffmpeg.stderr.on('data', (data: Buffer) => {
          const output = data.toString();
          // Prevent unbounded stderr buffer growth
          if (ffmpegStderrBuffer.length < MAX_STDERR_BUFFER_SIZE) {
            ffmpegStderrBuffer += output;
          } else if (ffmpegStderrBuffer.length === MAX_STDERR_BUFFER_SIZE) {
            ffmpegStderrBuffer += '\n... (stderr buffer limit reached, truncating further output) ...';
          }
          logger.debug(`[ffmpeg stderr] ${output.trim()}`);

          // Parse ffmpeg progress format: "frame=  662 fps=187 q=24.0 size=..."
          const ffmpegMatch = output.match(/frame=\s*(\d+)\s+fps=\s*([\d.]+)/i);
          
          if (ffmpegMatch) {
            currentFrame = parseInt(ffmpegMatch[1], 10);
            currentFPS = parseFloat(ffmpegMatch[2]);
            
            const percentage = totalFrames > 0 ? Math.round((currentFrame / totalFrames) * 100) : 0;

            // Log progress every 100 frames
            if (currentFrame % 100 === 0) {
              logger.upscale(`Progress: frame ${currentFrame}/${totalFrames} (${percentage}%) @ ${currentFPS.toFixed(1)} fps`);
            }

            this.sendProgress({
              type: 'progress',
              currentFrame,
              totalFrames,
              fps: currentFPS,
              percentage,
              message: this.isCanceling ? 'Stopping processing' : `Processing frame ${currentFrame}${totalFrames > 0 ? `/${totalFrames}` : ''}`,
              isStopping: this.isCanceling
            });
          }
        });
      }

      // Handle errors
      vspipe.on('error', (error) => {
        logger.error('vspipe process error:', error);
        logger.errorWithDialog('VapourSynth Process Error', `VapourSynth process failed to start or crashed: ${error.message}`);
        
        this.sendProgress({
          type: 'error',
          currentFrame: 0,
          totalFrames: 0,
          fps: 0,
          percentage: 0,
          message: `VapourSynth error: ${error.message}`
        });
        reject(error);
      });

      ffmpeg.on('error', (error) => {
        logger.error('ffmpeg process error:', error);
        logger.errorWithDialog('FFmpeg Process Error', `FFmpeg process failed to start or crashed: ${error.message}`);
        
        this.sendProgress({
          type: 'error',
          currentFrame: 0,
          totalFrames: 0,
          fps: 0,
          percentage: 0,
          message: `FFmpeg error: ${error.message}`
        });
        reject(error);
      });

      // Handle vspipe exit
      vspipe.on('close', (code) => {
        logger.upscale(`vspipe exited with code ${code}`);
        this.process = null; // Clear reference on exit
        
        if (code !== 0 && code !== null) {
          // Kill ffmpeg process since vspipe failed
          if (ffmpeg && !ffmpeg.killed) {
            ffmpeg.kill('SIGTERM');
            this.ffmpegProcess = null;
          }
          
          // Extract actual error from stderr
          const actualError = ErrorMessageHandler.extractErrorMessage(vspipeStderrBuffer);
          const errorMsg = ErrorMessageHandler.formatUserErrorMessage('VapourSynth Error', actualError);
          
          logger.errorWithDialog('VapourSynth Error', errorMsg);
          
          this.sendProgress({
            type: 'error',
            currentFrame: 0,
            totalFrames: 0,
            fps: 0,
            percentage: 0,
            message: errorMsg
          });
          
          reject(new Error(errorMsg));
        }
      });

      // Handle completion
      ffmpeg.on('close', (code) => {
        logger.upscale(`ffmpeg exited with code ${code}`);
        this.ffmpegProcess = null; // Clear reference on exit
        
        if (code === 0) {
          logger.upscale('Processing completed successfully!');
          logger.upscale(`Output saved to: ${outputPath}`);
          logger.separator();
          
          this.sendProgress({
            type: 'complete',
            currentFrame: totalFrames,
            totalFrames,
            fps: currentFPS,
            percentage: 100,
            message: 'Processing completed successfully!'
          });
          resolve();
        } else {
          logger.separator();
          
          // Extract actual error from stderr
          const actualError = ErrorMessageHandler.extractErrorMessage(ffmpegStderrBuffer);
          const errorMsg = ErrorMessageHandler.formatUserErrorMessage('FFmpeg Error', actualError);
          
          logger.errorWithDialog('FFmpeg Error', errorMsg);
          
          this.sendProgress({
            type: 'error',
            currentFrame: 0,
            totalFrames: 0,
            fps: 0,
            percentage: 0,
            message: errorMsg
          });
          
          reject(new Error(errorMsg));
        }
      });

      this.process = vspipe;
    });
  }

  cancel() {
    logger.upscale('Canceling upscale process gracefully');
    this.isCanceling = true;
    
    // Send stopping progress update
    this.sendProgress({
      type: 'progress',
      currentFrame: 0,
      totalFrames: 0,
      fps: 0,
      percentage: 0,
      message: 'Stopping processing...',
      isStopping: true
    });
    
    // Store references before clearing
    const vspipeProcess = this.process;
    const ffmpegProcess = this.ffmpegProcess;
    
    // Step 1: Unpipe vspipe from ffmpeg first
    if (vspipeProcess && vspipeProcess.stdout && ffmpegProcess && ffmpegProcess.stdin) {
      logger.upscale('Unpiping vspipe from ffmpeg');
      vspipeProcess.stdout.unpipe(ffmpegProcess.stdin);
    }
    
    // Step 2: Kill vspipe to stop new frames from being generated
    if (vspipeProcess) {
      logger.upscale('Stopping vspipe process (no new frames)');
      vspipeProcess.kill('SIGTERM');
      
      // Force kill vspipe if it doesn't exit
      setTimeout(() => {
        if (vspipeProcess && !vspipeProcess.killed) {
          logger.upscale('vspipe process did not exit gracefully, forcing termination');
          vspipeProcess.kill('SIGKILL');
        }
      }, 3000);
      
      this.process = null;
      logger.upscale('vspipe process termination initiated');
    }
    
    // Step 3: Close ffmpeg stdin to signal end of input, let it finish encoding
    if (ffmpegProcess) {
      logger.upscale('Closing ffmpeg stdin to finish encoding buffered frames');
      
      if (ffmpegProcess.stdin && !ffmpegProcess.stdin.destroyed) {
        ffmpegProcess.stdin.end();
      }
      
      logger.upscale('Waiting for ffmpeg to finish encoding (10 second timeout)');
      
      // Give ffmpeg time to finish encoding what it has (10 seconds)
      const ffmpegTimeout = setTimeout(() => {
        if (ffmpegProcess && !ffmpegProcess.killed) {
          logger.upscale('FFmpeg did not finish in time, sending SIGTERM');
          ffmpegProcess.kill('SIGTERM');
          
          // Force kill if SIGTERM doesn't work
          setTimeout(() => {
            if (ffmpegProcess && !ffmpegProcess.killed) {
              logger.upscale('FFmpeg did not exit gracefully, forcing termination');
              ffmpegProcess.kill('SIGKILL');
            }
          }, 3000);
        }
      }, 10000); // 10 second grace period for encoding
      
      // Clear timeout if ffmpeg exits naturally
      ffmpegProcess.once('close', () => {
        clearTimeout(ffmpegTimeout);
        logger.upscale('ffmpeg finished encoding and exited');
      });
      
      this.ffmpegProcess = null;
      logger.upscale('ffmpeg graceful shutdown initiated');
    }
    
    // Reset cancellation flag after all timeouts
    setTimeout(() => {
      this.isCanceling = false;
    }, 14000); // After all possible timeouts (10s + 3s + buffer)
  }
}