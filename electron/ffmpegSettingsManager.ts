// electron/ffmpegSettingsManager.ts
import { logger } from './logger';
import type { ConfigManager } from './configManager';
import { DEFAULT_FFMPEG_ARGS } from './configManager';
import { splitArgs } from './encodingSettings';

export interface FFmpegConfig {
  /** Video encoding arguments (e.g., codec, preset, quality) */
  videoArgs?: string[];
  /** Whether to preserve display aspect ratio from input */
  preserveAspectRatio?: boolean;
  /** Whether to copy metadata from input */
  copyMetadata?: boolean;
  /** Additional output flags (e.g., faststart for MP4) */
  movflags?: string[];
}

/**
 * Reads the FFmpeg encoding settings from the user's configuration
 */
export class FFmpegSettingsManager {
  /**
   * Parses a string of ffmpeg arguments into an array. Quoted values stay one argument.
   */
  private static parseArgsString(argsString: string): string[] {
    return splitArgs(argsString);
  }

  private static readonly DEFAULT_CONFIG: FFmpegConfig = {
    videoArgs: FFmpegSettingsManager.parseArgsString(DEFAULT_FFMPEG_ARGS),
    preserveAspectRatio: false,
    copyMetadata: false,
    movflags: []
  };

  /** The encoding arguments from the user's settings, or the defaults if they cannot be read. */
  static async loadFFmpegConfig(configManager: ConfigManager): Promise<FFmpegConfig> {
    try {
      // Only videoArgs: the user controls everything else on the command line.
      return {
        videoArgs: FFmpegSettingsManager.parseArgsString(configManager.getFfmpegArgs()),
        preserveAspectRatio: false,
        copyMetadata: false,
        movflags: []
      };
    } catch (error) {
      logger.warn('Failed to load FFmpeg settings from ConfigManager, using defaults:', error);
      return FFmpegSettingsManager.DEFAULT_CONFIG;
    }
  }
}
