import { logger } from './logger';
import { FFmpegManager } from './ffmpegManager';
import { PATHS } from './constants';
import { spawn } from 'child_process';
import { setupVSEnvironment } from './utils';
import { parseBestSourceProgress } from './bestSourceProgressParser';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';

/**
 * Extracts video metadata using ffmpeg
 */
export async function extractVideoMetadata(filePath: string): Promise<{
  resolution?: string;
  fps?: number;
  pixelFormat?: string;
  codec?: string;
  container?: string;
  scanType?: string;
  colorSpace?: string;
  duration?: string;
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
    let pixelFormat: string | undefined;
    let codec: string | undefined;
    let container: string | undefined;
    let scanType: string = 'Unknown';
    let colorSpace: string | undefined;
    let duration: string | undefined;
    
    // Parse container
    const containerMatch = output.match(/Input #0, ([\w,]+),/);
    if (containerMatch) {
      container = containerMatch[1].split(',')[0]; // Get first container format
    }

    // Find video stream line
    const videoStreamMatch = output.match(/Stream #\d+:\d+.*Video: (.*)/);
    if (videoStreamMatch) {
      const videoInfo = videoStreamMatch[1];
      
      // Parse codec
      const codecMatch = videoInfo.match(/^(\w+)/);
      if (codecMatch) {
        codec = codecMatch[1];
      }

      // Parse pixel format / color space
      // Usually looks like: h264 (High), yuv420p(tv, bt709), ...
      const parts = videoInfo.split(',').map((p: string) => p.trim());
      if (parts.length > 1) {
        // The second part is usually pixel format
        const pixFmt = parts[1];
        // Remove details in parens for cleaner display, but keep them for color space if needed
        pixelFormat = pixFmt.split('(')[0];
        colorSpace = pixFmt;
      }

      // Parse scan type with details
      let scanDetails: string[] = [];
      
      // Check for field order
      if (videoInfo.match(/tff|top first/i)) {
        scanDetails.push('Top Field First');
      } else if (videoInfo.match(/bff|bottom first/i)) {
        scanDetails.push('Bottom Field First');
      } else if (videoInfo.match(/mbaff/i)) {
        scanDetails.push('MBAFF');
      }
      
      // Check for pulldown patterns
      if (videoInfo.match(/pulldown/i) || videoInfo.match(/repeat headers/i)) {
        scanDetails.push('Pulldown');
      }

      // Check for progressive
      const isProgressive = videoInfo.match(/progressive/i);
      const isInterlaced = videoInfo.match(/interlaced|tff|bff|top first|bottom first|mbaff/i);

      if (isInterlaced) {
        scanType = 'Interlaced';
        if (scanDetails.length > 0) {
          scanType += ` (${scanDetails.join(', ')})`;
        }
      } else if (isProgressive) {
        scanType = 'Progressive';
      } else {
        // If we have scan details but didn't match "interlaced" explicitly, it's likely interlaced
        if (scanDetails.length > 0) {
          scanType = `Interlaced (${scanDetails.join(', ')})`;
        } else {
          // Default to Progressive if not explicitly interlaced
          scanType = 'Progressive';
        }
      }
    }
    
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
    
    // Parse duration (format: HH:MM:SS.ss)
    const durationMatch = output.match(/Duration: (\d+:\d+:\d+\.\d+)/);
    if (durationMatch) {
      duration = durationMatch[1];
      logger.info(`Parsed duration: ${duration}`);
    } else {
      logger.warn('Could not parse duration from ffmpeg output');
    }
    
    return { resolution, fps, pixelFormat, codec, container, scanType, colorSpace, duration };
  } catch (probeError) {
    logger.error('Error extracting video metadata with ffmpeg:', probeError);
    return {};
  }
}

/**
 * Gets the exact frame count from a video file using BestSource via VapourSynth
 */
export async function getVideoFrameCount(
  filePath: string,
  onProgress?: (percentage: number) => void
): Promise<number | undefined> {
  try {
    if (!fs.existsSync(PATHS.VSPIPE)) {
      logger.warn('VapourSynth vspipe not available for frame count extraction');
      return undefined;
    }

    if (!fs.existsSync(PATHS.PYTHON)) {
      logger.warn('VapourSynth Python not available for frame count extraction');
      return undefined;
    }

    const bestSourcePath = path.join(PATHS.PLUGINS, 'bestsource.dll');
    if (!fs.existsSync(bestSourcePath)) {
      logger.warn('BestSource plugin not available for frame count extraction');
      return undefined;
    }

    const tempDir = path.join(os.tmpdir(), 'vapourkit_framecount');
    await fs.ensureDir(tempDir);

    const scriptPath = path.join(tempDir, `framecount_${Date.now()}.vpy`);
    const escapedPath = filePath.replace(/\\/g, '\\\\');

    // cachemode=3 writes a .bsindex next to the source so the upscale step reuses it.
    const script = `import vapoursynth as vs
core = vs.core

clip = core.bs.VideoSource(source="${escapedPath}", cachemode=3)
clip.set_output()
`;

    await fs.writeFile(scriptPath, script, 'utf8');
    logger.info(`Created temporary frame count script: ${scriptPath}`);

    return new Promise<number | undefined>((resolve) => {
      const env = setupVSEnvironment(PATHS.PYTHON);

      const vspipe = spawn(PATHS.VSPIPE, ['-i', scriptPath, '-'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: env,
        cwd: PATHS.VS
      });

      let output = '';

      const appendOutput = (data: Buffer) => {
        output += data.toString();
      };

      const handleStderr = (data: Buffer) => {
        const text = data.toString();
        output += text;
        if (onProgress) {
          for (const pct of parseBestSourceProgress(text)) {
            onProgress(pct);
          }
        }
      };

      if (vspipe.stdout) {
        vspipe.stdout.on('data', appendOutput);
      }
      if (vspipe.stderr) {
        vspipe.stderr.on('data', handleStderr);
      }

      vspipe.on('close', async (code) => {
        try {
          await fs.remove(scriptPath);
        } catch (e) {
          // Ignore cleanup errors
        }

        if (code === 0) {
          const match = output.match(/Frames:\s*(\d+)/i);
          if (match) {
            const frames = parseInt(match[1], 10);
            logger.info(`Detected ${frames} frames from BestSource`);
            resolve(frames);
          } else {
            logger.warn('Could not parse frame count from vspipe output');
            logger.debug(`vspipe output: ${output.substring(0, 500)}`);
            resolve(undefined);
          }
        } else {
          logger.warn(`vspipe failed with code ${code}, could not get frame count`);
          logger.debug(`vspipe output: ${output.substring(0, 500)}`);
          resolve(undefined);
        }
      });

      vspipe.on('error', (error) => {
        logger.error('vspipe error during frame count extraction:', error);
        resolve(undefined);
      });
    });
  } catch (error) {
    logger.error('Error getting video frame count with BestSource:', error);
    return undefined;
  }
}
