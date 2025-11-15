import { ipcMain, dialog, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs-extra';
import { logger } from './logger';
import { PATHS } from './constants';
import { handleDialogResult } from './ipcUtilities';

/**
 * Registers all dialog-related IPC handlers
 */
export function registerDialogHandlers() {
  // File selection dialogs
  ipcMain.handle('select-video-file', async () => {
    logger.info('Opening video file selection dialog');
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Videos', extensions: ['mp4', 'avi', 'mkv', 'mov', 'webm', 'flv', 'wmv'] }
      ]
    });

    return handleDialogResult<string>(result, 'Video file selection');
  });

  ipcMain.handle('select-onnx-file', async () => {
    logger.info('Opening ONNX file selection dialog');
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'ONNX Models', extensions: ['onnx'] }
      ]
    });

    return handleDialogResult<string>(result, 'ONNX file selection');
  });

  ipcMain.handle('select-template-file', async () => {
    logger.info('Opening template file selection dialog');
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'VapourSynth Templates', extensions: ['vkfilter'] }
      ]
    });

    return handleDialogResult<string>(result, 'Template file selection');
  });

  ipcMain.handle('select-output-file', async (event, defaultName: string) => {
    logger.info(`Opening output file selection dialog with default: ${defaultName}`);
    
    const ext = path.extname(defaultName).slice(1) || 'mp4';
    
    const result = await dialog.showSaveDialog({
      defaultPath: defaultName,
      filters: [
        { name: 'Video Files', extensions: [ext] },
        { name: 'All Videos', extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm'] }
      ]
    });

    return handleDialogResult<string>(result, 'Output file selection');
  });

  ipcMain.handle('select-workflow-file', async (event, mode: 'open' | 'save') => {
    logger.info(`Selecting workflow file (mode: ${mode})`);
    try {
      if (mode === 'open') {
        const result = await dialog.showOpenDialog({
          properties: ['openFile'],
          filters: [
            { name: 'Vapourkit Workflow', extensions: ['vkworkflow'] },
            { name: 'All Files', extensions: ['*'] }
          ]
        });
        return result.canceled ? null : result.filePaths[0];
      } else {
        const result = await dialog.showSaveDialog({
          filters: [
            { name: 'Vapourkit Workflow', extensions: ['vkworkflow'] },
            { name: 'All Files', extensions: ['*'] }
          ],
          defaultPath: 'My Workflow.vkworkflow'
        });
        return result.canceled ? null : result.filePath;
      }
    } catch (error) {
      logger.error('Error selecting workflow file:', error);
      return null;
    }
  });

  // Folder opening handlers
  ipcMain.handle('open-output-folder', async (event, filePath: string) => {
    logger.info(`Opening output folder for: ${filePath}`);
    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`File does not exist: ${filePath}`);
      }
      const folderPath = path.dirname(filePath);
      await shell.openPath(folderPath);
      logger.info(`Opened folder: ${folderPath}`);
    } catch (error) {
      logger.error('Error opening output folder:', error);
      throw error;
    }
  });

  ipcMain.handle('open-logs-folder', async () => {
    logger.info('Opening logs folder');
    try {
      const logsDir = logger.getLogsDir();
      await fs.ensureDir(logsDir);
      shell.openPath(logsDir);
      return { success: true };
    } catch (error) {
      logger.error('Error opening logs folder:', error);
      throw error;
    }
  });

  ipcMain.handle('open-config-folder', async () => {
    logger.info('Opening config folder');
    try {
      await fs.ensureDir(PATHS.CONFIG);
      shell.openPath(PATHS.CONFIG);
      return { success: true };
    } catch (error) {
      logger.error('Error opening config folder:', error);
      throw error;
    }
  });

  ipcMain.handle('open-vs-plugins-folder', async () => {
    logger.info('Opening VapourSynth plugins folder');
    try {
      await fs.ensureDir(PATHS.PLUGINS);
      shell.openPath(PATHS.PLUGINS);
      return { success: true };
    } catch (error) {
      logger.error('Error opening VS plugins folder:', error);
      throw error;
    }
  });

  ipcMain.handle('open-vs-scripts-folder', async () => {
    logger.info('Opening VapourSynth scripts folder');
    try {
      await fs.ensureDir(PATHS.SCRIPTS);
      shell.openPath(PATHS.SCRIPTS);
      return { success: true };
    } catch (error) {
      logger.error('Error opening VS scripts folder:', error);
      throw error;
    }
  });

  ipcMain.handle('open-external', async (event, url: string) => {
    logger.info(`Opening external URL: ${url}`);
    await shell.openExternal(url);
    return { success: true };
  });
}
