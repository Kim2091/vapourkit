import { ipcMain, BrowserWindow, app } from 'electron';
import { logger } from './logger';
import { configManager } from './configManager';

/**
 * Registers all configuration-related IPC handlers
 */
export function registerConfigHandlers(mainWindow: BrowserWindow | null) {
  ipcMain.handle('get-color-matrix-settings', async () => {
    const settings = configManager.getColorMatrixSettings();
    return settings;
  });

  ipcMain.handle('set-color-matrix-settings', async (event, settings: { 
    overwriteMatrix: boolean; 
    matrix709: boolean; 
    defaultMatrix: '709' | '170m'; 
    defaultPrimaries: '709' | '601'; 
    defaultTransfer: '709' | '170m' 
  }) => {
    logger.info(`Setting color matrix: overwrite=${settings.overwriteMatrix}, matrix709=${settings.matrix709}, default=${settings.defaultMatrix}`);
    await configManager.setColorMatrixSettings(settings);
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

  ipcMain.handle('get-filter-presets', async () => {
    const presets = configManager.getFilterPresets();
    return presets;
  });

  ipcMain.handle('set-filter-presets', async (event, presets: { prefilterPreset: string; postfilterPreset: string }) => {
    logger.debug(`Setting filter presets: prefilter=${presets.prefilterPreset}, postfilter=${presets.postfilterPreset}`);
    await configManager.setFilterPresets(presets);
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

  ipcMain.handle('set-developer-mode', async (event, enabled: boolean) => {
    logger.info(`Setting developer mode: ${enabled}`);
    await configManager.setDeveloperMode(enabled);
    logger.setDeveloperMode(enabled, mainWindow);
    return { success: true, enabled };
  });

  ipcMain.handle('get-developer-mode', async () => {
    const enabled = configManager.getDeveloperMode();
    return { enabled };
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

  ipcMain.handle('get-processing-format', async () => {
    const format = configManager.getProcessingFormat();
    return { format };
  });

  ipcMain.handle('set-processing-format', async (event, format: string) => {
    logger.info(`Setting processing format: ${format}`);
    await configManager.setProcessingFormat(format);
    return { success: true };
  });

  ipcMain.handle('get-version', async () => {
    return { version: app.getVersion() };
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
}
