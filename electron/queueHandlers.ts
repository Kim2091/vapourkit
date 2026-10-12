import { ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs-extra';
import { logger } from './logger';
import { PATHS } from './constants';

const QUEUE_FILE = 'queue.json';

/**
 * Gets the path to the queue file
 */
function getQueueFilePath(): string {
  return path.join(PATHS.CONFIG, QUEUE_FILE);
}

/**
 * Registers all queue-related IPC handlers
 */
export function registerQueueHandlers() {
  // Get queue from disk
  ipcMain.handle('get-queue', async () => {
    logger.info('Loading queue from disk');
    try {
      const queuePath = getQueueFilePath();
      if (await fs.pathExists(queuePath)) {
        const data = await fs.readJson(queuePath);
        logger.info(`Loaded ${data.length} queue items`);
        return data;
      }
      logger.info('No existing queue found');
      return [];
    } catch (error) {
      logger.error('Error loading queue:', error);
      return [];
    }
  });

  // Save queue to disk
  ipcMain.handle('save-queue', async (event, queue: any[]) => {
    logger.info(`Saving queue with ${queue.length} items`);
    try {
      const queuePath = getQueueFilePath();
      await fs.ensureDir(path.dirname(queuePath));
      await fs.writeJson(queuePath, queue, { spaces: 2 });
      logger.info('Queue saved successfully');
      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('Error saving queue:', error);
      return { success: false, error: errorMsg };
    }
  });

  // Save queue to disk before the window goes: the renderer saves on a
  // delay, and an async save started while it unloads may never land, so the
  // last edits before quitting were lost. Synchronous, so it is done when the
  // window is allowed to close.
  ipcMain.on('save-queue-sync', (event, queue: any[]) => {
    try {
      const queuePath = getQueueFilePath();
      fs.ensureDirSync(path.dirname(queuePath));
      fs.writeJsonSync(queuePath, queue, { spaces: 2 });
      logger.info(`Saved queue with ${queue.length} items on close`);
      event.returnValue = { success: true };
    } catch (error) {
      logger.error('Error saving queue on close:', error);
      event.returnValue = { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Clear queue
  ipcMain.handle('clear-queue', async () => {
    logger.info('Clearing queue');
    try {
      const queuePath = getQueueFilePath();
      if (await fs.pathExists(queuePath)) {
        await fs.remove(queuePath);
        logger.info('Queue cleared');
      }
      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('Error clearing queue:', error);
      return { success: false, error: errorMsg };
    }
  });
}
