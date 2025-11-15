import * as path from 'path';
import * as fs from 'fs-extra';
import { PATHS } from './constants';
import { logger } from './logger';

/**
 * Manages the standalone ffmpeg binary
 * Downloads and extracts ffmpeg from gyan.dev if not present
 */
export class FFmpegManager {
  private static readonly FFMPEG_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-git-full.7z';
  private static readonly FFMPEG_DIR = path.join(PATHS.APP_DATA, 'ffmpeg');
  private static readonly FFMPEG_EXE = path.join(FFmpegManager.FFMPEG_DIR, 'bin', 'ffmpeg.exe');
  private static readonly FFPROBE_EXE = path.join(FFmpegManager.FFMPEG_DIR, 'bin', 'ffprobe.exe');

  /**
   * Gets the path to the ffmpeg executable
   * @returns Path to ffmpeg.exe or null if not available
   */
  static getFFmpegPath(): string | null {
    if (fs.existsSync(FFmpegManager.FFMPEG_EXE)) {
      return FFmpegManager.FFMPEG_EXE;
    }
    return null;
  }

  /**
   * Gets the path to the ffprobe executable
   * @returns Path to ffprobe.exe or null if not available
   */
  static getFFprobePath(): string | null {
    if (fs.existsSync(FFmpegManager.FFPROBE_EXE)) {
      return FFmpegManager.FFPROBE_EXE;
    }
    return null;
  }

  /**
   * Checks if ffmpeg is installed
   */
  static async isInstalled(): Promise<boolean> {
    return await fs.pathExists(FFmpegManager.FFMPEG_EXE);
  }

  /**
   * Downloads and extracts ffmpeg from gyan.dev
   * @param onProgress Optional progress callback
   */
  static async install(onProgress?: (message: string, progress: number) => void): Promise<void> {
    logger.dependency('Installing standalone ffmpeg from gyan.dev');
    
    if (await FFmpegManager.isInstalled()) {
      logger.dependency('FFmpeg already installed');
      onProgress?.('FFmpeg already installed', 100);
      return;
    }

    try {
      const axios = (await import('axios')).default;
      const sevenBin = require('7zip-bin');
      
      // Fix 7zip path for ASAR if needed
      let sevenZipPath = sevenBin.path7za;
      if (sevenZipPath.includes('app.asar') && !sevenZipPath.includes('app.asar.unpacked')) {
        sevenZipPath = sevenZipPath.replace('app.asar', 'app.asar.unpacked');
      }
      
      const _7z = (await import('7zip-min')).default;
      
      // Download ffmpeg
      const archivePath = path.join(PATHS.APP_DATA, 'ffmpeg-git-full.7z');
      
      onProgress?.('Downloading ffmpeg from gyan.dev...', 0);
      logger.dependency(`Downloading ffmpeg from ${FFmpegManager.FFMPEG_URL}`);
      
      await fs.ensureDir(path.dirname(archivePath));
      
      const response = await axios({
        url: FFmpegManager.FFMPEG_URL,
        method: 'GET',
        responseType: 'stream',
        onDownloadProgress: (progressEvent) => {
          const percentCompleted = progressEvent.total 
            ? Math.round((progressEvent.loaded * 100) / progressEvent.total)
            : 0;
          onProgress?.(`Downloading ffmpeg... ${percentCompleted}%`, percentCompleted * 0.8);
        }
      });

      const writer = fs.createWriteStream(archivePath);
      response.data.pipe(writer);

      await new Promise<void>((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      logger.dependency('Download completed, extracting...');
      onProgress?.('Extracting ffmpeg...', 80);

      // Extract directly to parent directory
      const extractPath = path.dirname(FFmpegManager.FFMPEG_DIR);
      await fs.ensureDir(extractPath);
      
      await new Promise<void>((resolve, reject) => {
        _7z.unpack(archivePath, extractPath, (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Find the extracted ffmpeg folder (it has a version number in the name)
      const extractedContents = await fs.readdir(extractPath);
      const ffmpegFolder = extractedContents.find(item => item.startsWith('ffmpeg-'));
      
      if (!ffmpegFolder) {
        throw new Error('Could not find ffmpeg folder in extracted archive');
      }

      const extractedFfmpegPath = path.join(extractPath, ffmpegFolder);
      
      // Rename to final location if needed
      if (extractedFfmpegPath !== FFmpegManager.FFMPEG_DIR) {
        // Remove existing ffmpeg directory if present
        if (await fs.pathExists(FFmpegManager.FFMPEG_DIR)) {
          await fs.remove(FFmpegManager.FFMPEG_DIR);
        }
        await fs.rename(extractedFfmpegPath, FFmpegManager.FFMPEG_DIR);
      }
      
      // Clean up archive
      await fs.remove(archivePath);

      onProgress?.('FFmpeg installed successfully', 100);
      logger.dependency('FFmpeg installation completed');
      logger.dependency(`FFmpeg path: ${FFmpegManager.FFMPEG_EXE}`);

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('Failed to install ffmpeg:', errorMsg);
      throw new Error(`FFmpeg installation failed: ${errorMsg}`);
    }
  }

  /**
   * Removes the installed ffmpeg
   */
  static async uninstall(): Promise<void> {
    logger.dependency('Uninstalling ffmpeg');
    if (await fs.pathExists(FFmpegManager.FFMPEG_DIR)) {
      await fs.remove(FFmpegManager.FFMPEG_DIR);
      logger.dependency('FFmpeg uninstalled');
    }
  }
}
