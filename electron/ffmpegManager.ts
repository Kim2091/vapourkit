import * as path from 'path';
import * as fs from 'fs-extra';
import { IS_WINDOWS, PATHS } from './constants';
import { downloadToFile } from './download';
import { logger } from './logger';
import { isCommandAvailable } from './utils';

/**
 * Manages FFmpeg. Windows uses the bundled standalone build; Linux uses the
 * distribution-provided ffmpeg/ffprobe commands on PATH.
 */
export class FFmpegManager {
  private static readonly FFMPEG_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-git-full.7z';
  private static readonly FFMPEG_DIR = path.join(PATHS.APP_DATA, 'ffmpeg');
  private static readonly FFMPEG_EXE = PATHS.FFMPEG;
  private static readonly FFPROBE_EXE = PATHS.FFPROBE;

  static getHostPrerequisiteMessage(): string {
    return 'FFmpeg and ffprobe are required on Linux. Install them with your distribution package manager (for example: apt install ffmpeg, dnf install ffmpeg, or pacman -S ffmpeg), then restart Vapourkit.';
  }

  /**
   * Gets the path to the ffmpeg executable
   * @returns A runnable ffmpeg command, or null when the bundled Windows copy
   * is absent. Linux availability is checked during setup.
   */
  static getFFmpegPath(): string | null {
    if (!IS_WINDOWS) {
      return 'ffmpeg';
    }
    if (fs.existsSync(FFmpegManager.FFMPEG_EXE)) {
      return FFmpegManager.FFMPEG_EXE;
    }
    return null;
  }

  /**
   * Gets the path to the ffprobe executable
   * @returns A runnable ffprobe command, or null when the bundled Windows copy
   * is absent. Linux availability is checked during setup.
   */
  static getFFprobePath(): string | null {
    if (!IS_WINDOWS) {
      return 'ffprobe';
    }
    if (fs.existsSync(FFmpegManager.FFPROBE_EXE)) {
      return FFmpegManager.FFPROBE_EXE;
    }
    return null;
  }

  /**
   * Checks if ffmpeg is installed
   */
  static async isInstalled(): Promise<boolean> {
    if (!IS_WINDOWS) {
      const [ffmpeg, ffprobe] = await Promise.all([
        isCommandAvailable('ffmpeg', ['-version']),
        isCommandAvailable('ffprobe', ['-version']),
      ]);
      return ffmpeg && ffprobe;
    }
    return await fs.pathExists(FFmpegManager.FFMPEG_EXE);
  }

  /**
   * Downloads and extracts ffmpeg from gyan.dev
   * @param onProgress Optional progress callback
   */
  static async install(onProgress?: (message: string, progress: number) => void): Promise<void> {
    if (!IS_WINDOWS) {
      throw new Error(FFmpegManager.getHostPrerequisiteMessage());
    }

    logger.dependency('Installing standalone ffmpeg from gyan.dev');
    
    if (await FFmpegManager.isInstalled()) {
      logger.dependency('FFmpeg already installed');
      onProgress?.('FFmpeg already installed', 100);
      return;
    }

    const archivePath = path.join(PATHS.APP_DATA, 'ffmpeg-git-full.7z');
    const extractPath = path.join(PATHS.APP_DATA, 'temp', 'ffmpeg-extract');

    try {
      const _7z = (await import('7zip-min')).default;

      await FFmpegManager.removeStaleExtractions();

      onProgress?.('Downloading ffmpeg from gyan.dev...', 0);
      await downloadToFile(FFmpegManager.FFMPEG_URL, archivePath, {
        label: 'FFmpeg',
        // The full build is well over 100 MB; anything this small is a
        // stub or error page, not the archive.
        minBytes: 10 * 1024 * 1024,
        onProgress: ({ received, total }) => {
          const percentCompleted = total ? Math.round((received * 100) / total) : 0;
          onProgress?.(`Downloading ffmpeg... ${percentCompleted}%`, percentCompleted * 0.8);
        },
      });

      logger.dependency('Download completed, extracting...');
      onProgress?.('Extracting ffmpeg...', 80);

      // Extracted into a folder of its own, emptied first. Extracting into
      // data\ and taking the first ffmpeg-* entry there picked up whatever an
      // earlier interrupted run had left behind, which could be half a build.
      await fs.remove(extractPath);
      await fs.ensureDir(extractPath);

      // The download now settles only after its file handle is closed, which
      // is what the old five-attempt loop here was really waiting out. What
      // remains is a scanner briefly holding the fresh archive, which shows
      // up as a sharing violation and clears within a second or two; a
      // "Can not open the file as archive" now means the file is bad, and
      // retrying it would only hide that.
      const maxAttempts = 3;
      for (let attempt = 1; ; attempt++) {
        try {
          await _7z.unpack(archivePath, extractPath);
          break;
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          const inUse = errorMessage.includes('being used by another process');
          if (!inUse || attempt >= maxAttempts) {
            throw err;
          }
          logger.dependency(`FFmpeg archive in use during extraction (attempt ${attempt}/${maxAttempts}), retrying...`);
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
      }

      // The archive holds one versioned folder (ffmpeg-<date>-git-<sha>-full_build);
      // it is recognised by what it contains rather than by its name.
      let extractedFfmpegPath: string | null = null;
      for (const entry of await fs.readdir(extractPath)) {
        const candidate = path.join(extractPath, entry);
        if (await fs.pathExists(path.join(candidate, 'bin', 'ffmpeg.exe'))) {
          extractedFfmpegPath = candidate;
          break;
        }
      }
      if (!extractedFfmpegPath) {
        throw new Error('Could not find ffmpeg folder in extracted archive');
      }

      await fs.remove(FFmpegManager.FFMPEG_DIR);
      await fs.move(extractedFfmpegPath, FFmpegManager.FFMPEG_DIR);

      if (!await fs.pathExists(FFmpegManager.FFMPEG_EXE)) {
        throw new Error(`Extraction finished but ${FFmpegManager.FFMPEG_EXE} is missing`);
      }

      onProgress?.('FFmpeg installed successfully', 100);
      logger.dependency('FFmpeg installation completed');
      logger.dependency(`FFmpeg path: ${FFmpegManager.FFMPEG_EXE}`);

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('Failed to install ffmpeg:', errorMsg);
      throw new Error(`FFmpeg installation failed: ${errorMsg}`);
    } finally {
      await fs.remove(archivePath).catch(() => undefined);
      await fs.remove(extractPath).catch(() => undefined);
    }
  }

  /**
   * Earlier versions extracted straight into data\, so an interrupted
   * install left a versioned ffmpeg-*_build folder there that nothing ever
   * removed (and that a later install could mistake for its own). Only
   * folders of that shape are touched; data\ffmpeg itself never matches.
   */
  private static async removeStaleExtractions(): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.readdir(PATHS.APP_DATA, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('ffmpeg-') && entry.name.endsWith('_build')) {
        logger.dependency(`Removing leftover ffmpeg extraction ${entry.name}`);
        await fs.remove(path.join(PATHS.APP_DATA, entry.name)).catch(error => {
          logger.warn(`Could not remove leftover ${entry.name}:`, error);
        });
      }
    }
  }

  /**
   * Removes the installed ffmpeg
   */
  static async uninstall(): Promise<void> {
    if (!IS_WINDOWS) {
      logger.dependency('FFmpeg is managed by the Linux distribution package manager');
      return;
    }
    logger.dependency('Uninstalling ffmpeg');
    if (await fs.pathExists(FFmpegManager.FFMPEG_DIR)) {
      await fs.remove(FFmpegManager.FFMPEG_DIR);
      logger.dependency('FFmpeg uninstalled');
    }
  }
}
