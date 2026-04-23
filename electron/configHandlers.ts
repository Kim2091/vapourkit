import { ipcMain, BrowserWindow, app } from 'electron';
import * as fs from 'fs-extra';
import * as path from 'path';
import { logger } from './logger';
import { configManager } from './configManager';
import { VS_MLRT_VERSION, PATHS } from './constants';
import { VsMlrtManager } from './vsMlrtManager';

// Cache for log file reading - stores last file size for change detection
let lastLogSize = 0;

/**
 * Registers all configuration-related IPC handlers
 */
export function registerConfigHandlers(mainWindow: BrowserWindow | null) {
  ipcMain.handle('get-colorimetry-settings', async () => {
    const settings = configManager.getColorimetrySettings();
    return settings;
  });

  ipcMain.handle('set-colorimetry-settings', async (event, settings: { 
    overwriteMatrix: boolean; 
    matrix709: boolean; 
    defaultMatrix: '709' | '170m'; 
    defaultPrimaries: '709' | '601'; 
    defaultTransfer: '709' | '170m' 
  }) => {
    logger.info(`Setting colorimetry: overwrite=${settings.overwriteMatrix}, matrix709=${settings.matrix709}, default=${settings.defaultMatrix}`);
    await configManager.setColorimetrySettings(settings);
    return { success: true };
  });

  ipcMain.handle('get-panel-sizes', async () => {
    const sizes = configManager.getPanelSizes();
    return sizes;
  });

  ipcMain.handle('set-panel-sizes', async (event, sizes: { leftPanel: number; rightPanel: number; queuePanel?: number }) => {
    logger.debug(`Setting panel sizes: left=${sizes.leftPanel}, right=${sizes.rightPanel}, queue=${sizes.queuePanel}`);
    await configManager.setPanelSizes(sizes);
    return { success: true };
  });

  ipcMain.handle('get-show-queue', async () => {
    const show = configManager.getShowQueue();
    return { show };
  });

  ipcMain.handle('set-show-queue', async (event, show: boolean) => {
    logger.debug(`Setting show queue: ${show}`);
    await configManager.setShowQueue(show);
    return { success: true };
  });

  ipcMain.handle('get-filter-configurations', async () => {
    const filters = configManager.getFilterConfigurations();
    return filters;
  });

  ipcMain.handle('set-filter-configurations', async (event, filters: any[]) => {
    logger.debug(`Setting filter configurations: ${filters.length} filters`);
    await configManager.setFilterConfigurations(filters);
    return { success: true };
  });

  ipcMain.handle('get-ffmpeg-args', async () => {
    const args = configManager.getFfmpegArgs();
    return { args };
  });

  ipcMain.handle('set-ffmpeg-args', async (event, args: string) => {
    logger.info(`Setting ffmpeg args: ${args}`);
    await configManager.setFfmpegArgs(args);
    return { success: true };
  });

  ipcMain.handle('get-default-ffmpeg-args', async () => {
    const args = configManager.getDefaultFfmpegArgs();
    return { args };
  });

  ipcMain.handle('get-output-format', async () => {
    const format = configManager.getOutputFormat();
    return { format };
  });

  ipcMain.handle('set-output-format', async (event, format: string) => {
    logger.info(`Setting output format: ${format}`);
    await configManager.setOutputFormat(format);
    return { success: true };
  });

  ipcMain.handle('get-processing-format', async () => {
    const format = configManager.getProcessingFormat();
    return { format };
  });

  ipcMain.handle('set-processing-format', async (event, format: string) => {
    logger.info(`Setting processing format: ${format}`);
    await configManager.setProcessingFormat(format);
    return { success: true };
  });

  ipcMain.handle('get-video-compare-args', async () => {
    const args = configManager.getVideoCompareArgs();
    return { args };
  });

  ipcMain.handle('set-video-compare-args', async (event, args: string) => {
    logger.info(`Setting video compare args: ${args}`);
    await configManager.setVideoCompareArgs(args);
    return { success: true };
  });

  ipcMain.handle('get-default-video-compare-args', async () => {
    const args = configManager.getDefaultVideoCompareArgs();
    return { args };
  });

  ipcMain.handle('get-default-output-folder', async () => {
    const folder = configManager.getDefaultOutputFolder();
    return { folder };
  });

  ipcMain.handle('set-default-output-folder', async (event, folder: string | null) => {
    logger.info(`Setting default output folder: ${folder}`);
    await configManager.setDefaultOutputFolder(folder);
    return { success: true };
  });

  ipcMain.handle('get-descriptive-naming-enabled', async () => {
    const enabled = configManager.getDescriptiveNamingEnabled();
    return { enabled };
  });

  ipcMain.handle('set-descriptive-naming-enabled', async (event, enabled: boolean) => {
    logger.info(`Setting descriptive naming enabled: ${enabled}`);
    await configManager.setDescriptiveNamingEnabled(enabled);
    return { success: true };
  });

  ipcMain.handle('get-encoding-settings-expanded', async () => {
    const expanded = configManager.getEncodingSettingsExpanded();
    return { expanded };
  });

  ipcMain.handle('set-encoding-settings-expanded', async (event, expanded: boolean) => {
    await configManager.setEncodingSettingsExpanded(expanded);
    return { success: true };
  });

  ipcMain.handle('get-version', async () => {
    return { version: app.getVersion() };
  });

  // Read the last N lines from the log file (efficient tail reading)
  ipcMain.handle('read-log-tail', async (event, maxLines: number = 300) => {
    try {
      const logPath = logger.getLogPath();
      
      // Check if file exists
      if (!await fs.pathExists(logPath)) {
        return { lines: [], hasNewContent: false };
      }
      
      const stats = await fs.stat(logPath);
      const currentSize = stats.size;
      
      // Check if file has changed since last read
      const hasNewContent = currentSize !== lastLogSize;
      
      if (!hasNewContent) {
        // File hasn't changed, return empty to signal no update needed
        return { lines: [], hasNewContent: false };
      }
      
      lastLogSize = currentSize;
      
      // Read the file efficiently - only read last portion if file is large
      const MAX_BYTES_TO_READ = 512 * 1024; // 512KB max
      let content: string;
      
      if (currentSize > MAX_BYTES_TO_READ) {
        // Read only the last portion of the file
        const fd = await fs.open(logPath, 'r');
        const buffer = Buffer.alloc(MAX_BYTES_TO_READ);
        const startPosition = currentSize - MAX_BYTES_TO_READ;
        await fs.read(fd, buffer, 0, MAX_BYTES_TO_READ, startPosition);
        await fs.close(fd);
        content = buffer.toString('utf-8');
        // Remove potentially incomplete first line
        const firstNewline = content.indexOf('\n');
        if (firstNewline > 0) {
          content = content.substring(firstNewline + 1);
        }
      } else {
        content = await fs.readFile(logPath, 'utf-8');
      }
      
      // Split into lines and take last N
      const allLines = content.split('\n').filter(line => line.trim().length > 0);
      const lines = allLines.slice(-maxLines);
      
      return { lines, hasNewContent: true };
    } catch (error) {
      // Don't log errors here to avoid infinite loops
      return { lines: [], hasNewContent: false, error: String(error) };
    }
  });

  // Reset log read cache (call when user wants to force refresh)
  ipcMain.handle('reset-log-cache', async () => {
    lastLogSize = 0;
    return { success: true };
  });

  ipcMain.handle('reload-backend', async () => {
    logger.info('Reloading backend (models and configs)');
    try {
      // Reload config manager
      await configManager.load();
      logger.info('Config reloaded');
      
      // Models will be refreshed by the frontend calling get-available-models
      logger.info('Backend reload complete');
      
      return { success: true };
    } catch (error) {
      logger.error('Error reloading backend:', error);
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMsg };
    }
  });

  ipcMain.handle('file-exists', async (event, filePath: string) => {
    logger.debug(`Checking if file exists: ${filePath}`);
    try {
      const fs = require('fs');
      const exists = fs.existsSync(filePath);
      logger.debug(`File exists: ${exists}`);
      return exists;
    } catch (error) {
      logger.error('Error checking file existence:', error);
      return false;
    }
  });

  // vs-mlrt version check - returns info about version mismatch and existing engines
  ipcMain.handle('check-vsmlrt-version', async () => {
    try {
      const storedVersion = configManager.getVsMlrtVersion();
      const currentVersion = VS_MLRT_VERSION;
      const hasVersionMismatch = storedVersion !== undefined && storedVersion !== currentVersion;
      
      // Count existing engine files
      let engineCount = 0;
      if (await fs.pathExists(PATHS.MODELS)) {
        const files = await fs.readdir(PATHS.MODELS);
        engineCount = files.filter((f: string) => f.endsWith('.engine')).length;
      }
      
      logger.info(`vs-mlrt version check: stored=${storedVersion}, current=${currentVersion}, mismatch=${hasVersionMismatch}, engines=${engineCount}`);
      
      return {
        storedVersion,
        currentVersion,
        hasVersionMismatch,
        engineCount,
        needsNotification: hasVersionMismatch && engineCount > 0
      };
    } catch (error) {
      logger.error('Error checking vs-mlrt version:', error);
      return {
        storedVersion: undefined,
        currentVersion: VS_MLRT_VERSION,
        hasVersionMismatch: false,
        engineCount: 0,
        needsNotification: false
      };
    }
  });

  // Clear all engine files
  ipcMain.handle('clear-engine-files', async () => {
    try {
      if (!await fs.pathExists(PATHS.MODELS)) {
        return { success: true, deletedCount: 0 };
      }
      
      const files = await fs.readdir(PATHS.MODELS);
      const engineFiles = files.filter((f: string) => f.endsWith('.engine'));
      
      for (const engineFile of engineFiles) {
        const enginePath = path.join(PATHS.MODELS, engineFile);
        await fs.remove(enginePath);
        logger.info(`Deleted engine file: ${engineFile}`);
      }
      
      logger.info(`Cleared ${engineFiles.length} engine files`);
      return { success: true, deletedCount: engineFiles.length };
    } catch (error) {
      logger.error('Error clearing engine files:', error);
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMsg, deletedCount: 0 };
    }
  });

  // Update stored vs-mlrt version to current
  ipcMain.handle('update-vsmlrt-version', async () => {
    try {
      await configManager.setVsMlrtVersion(VS_MLRT_VERSION);
      logger.info(`Updated stored vs-mlrt version to ${VS_MLRT_VERSION}`);
      return { success: true, version: VS_MLRT_VERSION };
    } catch (error) {
      logger.error('Error updating vs-mlrt version:', error);
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMsg };
    }
  });

  // Automatically update vs-mlrt plugin when version changes
  ipcMain.handle('update-vsmlrt-plugin', async (event) => {
    try {
      logger.info('=== Starting automatic vs-mlrt plugin update ===');
      
      // Import utils to check CUDA support
      const { detectCudaSupport } = await import('./utils');
      const hasCuda = await detectCudaSupport();
      
      if (!hasCuda) {
        logger.info('No CUDA detected, skipping vs-mlrt TensorRT plugin update');
        return { success: false, error: 'CUDA not detected. TensorRT plugin requires NVIDIA GPU.' };
      }

      // Use the unified VsMlrtManager to download and install TensorRT
      await VsMlrtManager.downloadAndInstall(
        'tensorrt',
        VsMlrtManager.createWindowProgressCallback(mainWindow, 'vsmlrt-update-progress')
      );

      // Update the stored version
      await configManager.setVsMlrtVersion(VS_MLRT_VERSION);
      logger.info('=== vs-mlrt plugin update completed successfully ===');

      return { success: true, version: VS_MLRT_VERSION };
    } catch (error) {
      logger.error('Error updating vs-mlrt plugin:', error);
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMsg };
    }
  });
}
