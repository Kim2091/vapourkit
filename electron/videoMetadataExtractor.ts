// electron/videoMetadataExtractor.ts
import { spawn } from 'child_process';
import * as path from 'path';
import { logger } from './logger';
import { FFmpegManager } from './ffmpegManager';

export interface VideoMetadata {
  hasAudio: boolean;
  hasSubtitles: boolean;
  dar: string | null; // Display Aspect Ratio
  duration: number | null;
  audioStreams: number;
  subtitleStreams: number;
}

export interface VideoValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Utility class for extracting video metadata and validating videos for upscaling
 */
export class VideoMetadataExtractor {
  /**
   * Extracts metadata from a video file including audio, subtitles, DAR, and duration
   */
  static async getVideoMetadata(inputPath: string): Promise<VideoMetadata> {
    logger.upscale('Extracting video metadata');
    
    return new Promise((resolve, reject) => {
      const ffmpegPath = FFmpegManager.getFFmpegPath();
      if (!ffmpegPath) {
        reject(new Error('ffmpeg not available'));
        return;
      }

      const ffprobe = spawn(ffmpegPath, [
        '-i', inputPath,
        '-hide_banner'
      ], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let output = '';
      
      if (ffprobe.stderr) {
        ffprobe.stderr.on('data', (data: Buffer) => {
          output += data.toString();
        });
      }

      ffprobe.on('close', () => {
        const metadata: VideoMetadata = {
          hasAudio: /Stream #\d+:\d+.*Audio/.test(output),
          hasSubtitles: /Stream #\d+:\d+.*Subtitle/.test(output),
          dar: null,
          duration: null,
          audioStreams: (output.match(/Stream #\d+:\d+.*Audio/g) || []).length,
          subtitleStreams: (output.match(/Stream #\d+:\d+.*Subtitle/g) || []).length
        };

        // Extract DAR
        const darMatch = output.match(/DAR (\d+:\d+)/);
        if (darMatch) {
          metadata.dar = darMatch[1];
        }

        // Extract duration
        const durationMatch = output.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
        if (durationMatch) {
          const hours = parseInt(durationMatch[1]);
          const minutes = parseInt(durationMatch[2]);
          const seconds = parseFloat(durationMatch[3]);
          metadata.duration = hours * 3600 + minutes * 60 + seconds;
        }

        logger.upscale(`Metadata: Audio=${metadata.hasAudio} (${metadata.audioStreams} streams), Subtitles=${metadata.hasSubtitles} (${metadata.subtitleStreams} streams), DAR=${metadata.dar || 'N/A'}`);
        resolve(metadata);
      });

      ffprobe.on('error', (error) => {
        logger.error('ffprobe error:', error);
        reject(error);
      });
    });
  }

  /**
   * Validates a video file for upscaling compatibility
   * Checks for requirements like even dimensions for AI models
   */
  static async validateVideoForUpscaling(inputPath: string): Promise<VideoValidationResult> {
    logger.upscale('Validating video for upscaling compatibility');
    
    return new Promise((resolve) => {
      const ffmpegPath = FFmpegManager.getFFmpegPath();
      if (!ffmpegPath) {
        resolve({ valid: true }); // Don't block if ffmpeg unavailable
        return;
      }

      const ffprobe = spawn(ffmpegPath, [
        '-i', inputPath,
        '-hide_banner'
      ], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let output = '';
      
      if (ffprobe.stderr) {
        ffprobe.stderr.on('data', (data: Buffer) => {
          output += data.toString();
        });
      }

      ffprobe.on('close', () => {
        // Extract resolution
        const resolutionMatch = output.match(/Stream.*Video.*?[,\s](\d{2,5})x(\d{2,5})[,\s]/i);
        
        if (resolutionMatch) {
          const width = parseInt(resolutionMatch[1]);
          const height = parseInt(resolutionMatch[2]);
          
          // Check for odd dimensions - AI models require even dimensions
          if (width % 2 !== 0 || height % 2 !== 0) {
            const errorMsg = `Invalid resolution ${width}x${height}. AI upscaling models require both width and height to be even numbers.\n\nCurrent dimensions:\n- Width: ${width} (${width % 2 === 0 ? 'even ✓' : 'ODD ✗'})\n- Height: ${height} (${height % 2 === 0 ? 'even ✓' : 'ODD ✗'})\n\nPlease resize your video to even dimensions before upscaling.`;
            logger.error(`Resolution validation failed: ${errorMsg}`);
            resolve({ valid: false, error: errorMsg });
            return;
          }
          
          logger.upscale(`Resolution validation passed: ${width}x${height} (both dimensions are even)`);
        }
        
        resolve({ valid: true });
      });

      ffprobe.on('error', (error) => {
        logger.warn('Error during video validation (non-fatal):', error);
        resolve({ valid: true }); // Don't block on validation errors
      });
    });
  }

  /**
   * Determines the best output file extension based on input format
   */
  static getOutputExtension(inputPath: string): string {
    const ext = path.extname(inputPath).toLowerCase();
    // Map common video extensions
    const supportedExts = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv', '.wmv', '.m4v'];
    
    if (supportedExts.includes(ext)) {
      // For maximum compatibility with audio/subs, prefer mkv or mp4
      if (ext === '.mkv' || ext === '.mp4') {
        return ext;
      }
      // For other formats, use mkv as it supports almost everything
      return '.mkv';
    }
    
    // Default to mkv for unknown formats
    return '.mkv';
  }
}
