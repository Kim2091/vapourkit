// electron/videoMetadataExtractor.ts
import * as path from 'path';
import { logger } from './logger';

export interface VideoMetadata {
  hasAudio: boolean;
  hasSubtitles: boolean;
  dar: string | null; // Display Aspect Ratio
  duration: number | null;
  audioStreams: number;
  subtitleStreams: number;
}

/**
 * Reads the stream layout, display aspect ratio and duration from the stderr
 * of `ffmpeg -i`.
 */
export function parseVideoMetadata(output: string): VideoMetadata {
  const metadata: VideoMetadata = {
    hasAudio: /Stream #\d+:\d+.*Audio/.test(output),
    hasSubtitles: /Stream #\d+:\d+.*Subtitle/.test(output),
    dar: null,
    duration: null,
    audioStreams: (output.match(/Stream #\d+:\d+.*Audio/g) || []).length,
    subtitleStreams: (output.match(/Stream #\d+:\d+.*Subtitle/g) || []).length
  };

  const darMatch = output.match(/DAR (\d+:\d+)/);
  if (darMatch) {
    metadata.dar = darMatch[1];
  }

  const durationMatch = output.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
  if (durationMatch) {
    const hours = parseInt(durationMatch[1]);
    const minutes = parseInt(durationMatch[2]);
    const seconds = parseFloat(durationMatch[3]);
    metadata.duration = hours * 3600 + minutes * 60 + seconds;
  }

  logger.upscale(`Metadata: Audio=${metadata.hasAudio} (${metadata.audioStreams} streams), Subtitles=${metadata.hasSubtitles} (${metadata.subtitleStreams} streams), DAR=${metadata.dar || 'N/A'}`);
  return metadata;
}

/**
 * Output naming helpers for upscaled videos
 */
export class VideoMetadataExtractor {
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
