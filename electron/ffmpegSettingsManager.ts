// electron/ffmpegSettingsManager.ts
import * as path from 'path';
import * as fs from 'fs-extra';
import { logger } from './logger';
import { PATHS } from './constants';
import type { ConfigManager } from './configManager';
import { DEFAULT_FFMPEG_ARGS } from './configManager';

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
 * Manages FFmpeg encoding settings loading from user configuration
 */
export class FFmpegSettingsManager {
  /**
   * Parses a space-separated string of ffmpeg arguments into an array
   */
  private static parseArgsString(argsString: string): string[] {
    return argsString.trim().split(/\s+/).filter(arg => arg.length > 0);
  }

  private static readonly DEFAULT_CONFIG: FFmpegConfig = {
    videoArgs: FFmpegSettingsManager.parseArgsString(DEFAULT_FFMPEG_ARGS),
    preserveAspectRatio: false,
    copyMetadata: false,
    movflags: []
  };

  /**
   * Loads FFmpeg configuration from ConfigManager or falls back to file-based config
   */
  static async loadFFmpegConfig(configManager?: ConfigManager): Promise<FFmpegConfig> {
    // If configManager is provided, use it (new approach)
    // Return only videoArgs - user controls everything via command line
    if (configManager) {
      try {
        const argsString = configManager.getFfmpegArgs();
        const videoArgs = FFmpegSettingsManager.parseArgsString(argsString);
        
        // Don't force any additional flags - user has full control via command line
        return {
          videoArgs,
          preserveAspectRatio: false,
          copyMetadata: false,
          movflags: []
        };
      } catch (error) {
        logger.warn('Failed to load FFmpeg settings from ConfigManager, using defaults:', error);
        return FFmpegSettingsManager.DEFAULT_CONFIG;
      }
    }
    
    // Legacy: Load from file (old approach, for backward compatibility)
    const userConfigPath = path.join(PATHS.CONFIG, 'ffmpeg_settings.json');
    
    try {
      if (await fs.pathExists(userConfigPath)) {
        const userConfig = await fs.readJson(userConfigPath);
        
        // Support legacy format ("args" array only)
        if (userConfig.args && !userConfig.videoArgs) {
          return {
            videoArgs: userConfig.args,
            preserveAspectRatio: userConfig.preserveAspectRatio ?? FFmpegSettingsManager.DEFAULT_CONFIG.preserveAspectRatio,
            copyMetadata: userConfig.copyMetadata ?? FFmpegSettingsManager.DEFAULT_CONFIG.copyMetadata,
            movflags: userConfig.movflags ?? FFmpegSettingsManager.DEFAULT_CONFIG.movflags
          };
        }
        
        // New format
        return {
          videoArgs: userConfig.videoArgs ?? FFmpegSettingsManager.DEFAULT_CONFIG.videoArgs,
          preserveAspectRatio: userConfig.preserveAspectRatio ?? FFmpegSettingsManager.DEFAULT_CONFIG.preserveAspectRatio,
          copyMetadata: userConfig.copyMetadata ?? FFmpegSettingsManager.DEFAULT_CONFIG.copyMetadata,
          movflags: userConfig.movflags ?? FFmpegSettingsManager.DEFAULT_CONFIG.movflags
        };
      }
    } catch (error) {
      logger.warn('Failed to load user FFmpeg settings, using defaults:', error);
    }
    
    return FFmpegSettingsManager.DEFAULT_CONFIG;
  }

  /**
   * Loads FFmpeg video encoding settings (legacy method for backward compatibility)
   */
  static async loadFFmpegSettings(configManager?: ConfigManager): Promise<string[]> {
    const config = await FFmpegSettingsManager.loadFFmpegConfig(configManager);
    return config.videoArgs || [];
  }

  /**
   * Gets the default FFmpeg configuration
   */
  static getDefaultConfig(): FFmpegConfig {
    return { ...FFmpegSettingsManager.DEFAULT_CONFIG };
  }

  /**
   * Gets the default FFmpeg settings (legacy method)
   */
  static getDefaultSettings(): string[] {
    return [...(FFmpegSettingsManager.DEFAULT_CONFIG.videoArgs || [])];
  }

  /**
   * Converts an array of FFmpeg arguments to a space-separated string
   */
  static argsToString(args: string[]): string {
    return args.join(' ');
  }

  /**
   * Gets the default FFmpeg args as a string
   */
  static getDefaultArgsString(): string {
    return DEFAULT_FFMPEG_ARGS;
  }
}
