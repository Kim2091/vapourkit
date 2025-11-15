import { logger } from './logger';
import { FFmpegManager } from './ffmpegManager';

/**
 * Extracts video metadata using ffmpeg
 */
export async function extractVideoMetadata(filePath: string): Promise<{
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
