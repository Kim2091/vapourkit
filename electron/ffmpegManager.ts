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
      
      // Retry logic for file locking issues on Windows
      const maxRetries = 5;
      const retryDelay = 2000; // 2 seconds
      let lastError: any = null;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await new Promise<void>((resolve, reject) => {
            _7z.unpack(archivePath, extractPath, (err: Error | null) => {
              if (err) reject(err);
              else resolve();
            });
          });
          
          // Success, break out of retry loop
          break;
        } catch (err: any) {
          lastError = err;
          const errorMessage = err.message || String(err);
          
          // Check if it's a file locking error
          const isFileLockError = 
            errorMessage.includes('Can not open the file as archive') ||
            errorMessage.includes('The process cannot access the file because it is being used by another process') ||
            errorMessage.includes("Can't open as archive");
          
          if (isFileLockError && attempt < maxRetries) {
            logger.dependency(`File locked during extraction (attempt ${attempt}/${maxRetries}), retrying in ${retryDelay}ms...`);
            onProgress?.(`FFmpeg - file locked, retrying (${attempt}/${maxRetries})...`, 80 + Math.round((attempt / maxRetries) * 10));
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            continue;
          }
          
          // If it's not a file lock error, or we've exhausted retries, throw
          if (attempt === maxRetries) {
            logger.error(`Failed to extract ffmpeg after ${maxRetries} attempts`);
            throw lastError;
          }
          throw err;
        }
      }

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
