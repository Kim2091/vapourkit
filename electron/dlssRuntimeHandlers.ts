import { ipcMain, dialog } from 'electron';

import { logger } from './logger';
import { createIpcHandler } from './ipcUtilities';
import {
  getRuntimeStatus,
  importRuntimeFromPath,
  validateRuntimeFile,
} from './dlssRuntimeManager';

/**
 * IPC for importing the DLSS 5 Neural Uplift runtime: a file picker, a validation, and a copy
 * into the VapourSynth plugins folder. The user never has to know where that folder is.
 */
export function registerDlssRuntimeHandlers() {
  ipcMain.handle(
    'dlss-runtime-status',
    createIpcHandler('dlss-runtime-status', () => getRuntimeStatus(), { throwOnError: true }),
  );

  ipcMain.handle('dlss-runtime-import', async () => {
    logger.info('IPC Handler: dlss-runtime-import');
    try {
      const result = await dialog.showOpenDialog({
        title: 'Select the DLSS 5 runtime (nvngx_dlssnr.dll)',
        properties: ['openFile'],
        filters: [{ name: 'DLSS 5 runtime', extensions: ['dll'] }],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }

      const chosen = result.filePaths[0];

      // Validated before anything is copied, so picking the wrong NGX DLL fails with a reason
      // rather than installing something that cannot load.
      const validation = await validateRuntimeFile(chosen);
      if (!validation.valid) {
        return { success: false, canceled: false, error: validation.reason };
      }

      const imported = await importRuntimeFromPath(chosen);
      logger.info('dlss-runtime-import completed:', imported);
      return { ...imported, canceled: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('dlss-runtime-import failed:', message);
      return { success: false, canceled: false, error: message };
    }
  });
}
