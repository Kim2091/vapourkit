import { ipcMain } from 'electron';
import * as path from 'path';
import { logger } from './logger';
import { PATHS } from './constants';
import { JsonFileWriter, readJsonOrSetAside } from './jsonFile';

const QUEUE_FILE = 'queue.json';

/**
 * Gets the path to the queue file
 */
function getQueueFilePath(): string {
  return path.join(PATHS.CONFIG, QUEUE_FILE);
}

// One writer for every save path (debounced, on close, clear), so whichever
// was asked for last is what stays on disk, however the writes finish.
const queueWriter = new JsonFileWriter(getQueueFilePath);

/**
 * Registers all queue-related IPC handlers
 */
export function registerQueueHandlers() {
  // Get queue from disk
  ipcMain.handle('get-queue', async () => {
    logger.info('Loading queue from disk');
    const queuePath = getQueueFilePath();
    const read = await readJsonOrSetAside<unknown>(queuePath);
    switch (read.kind) {
      case 'ok':
        if (Array.isArray(read.value)) {
          queueWriter.unblock();
          logger.info(`Loaded ${read.value.length} queue items`);
          return read.value;
        }
        // Valid JSON but not a queue: keep it rather than save [] over it.
        queueWriter.block('the queue file holds something other than a queue');
        logger.error('Queue file is not a list; not saving over it this session');
        return [];
      case 'missing':
        queueWriter.unblock();
        logger.info('No existing queue found');
        return [];
      case 'corrupt':
        // The renderer saves what it loaded straight away, so an empty queue
        // would replace the file within seconds. Only once the old file is
        // kept somewhere is that allowed.
        if (read.setAsideTo) {
          queueWriter.unblock();
          logger.error(`Queue file was not valid JSON; moved it to ${read.setAsideTo}:`, read.error);
        } else {
          queueWriter.block('the queue file could not be read or moved aside');
          logger.error('Queue file was not valid JSON and could not be moved aside; not saving over it this session:', read.error);
        }
        return [];
      case 'unreadable':
        queueWriter.block('the queue file could not be read');
        logger.error('Error loading queue; not saving over it this session:', read.error);
        return [];
    }
  });

  // Save queue to disk
  ipcMain.handle('save-queue', async (event, queue: any[]) => {
    logger.info(`Saving queue with ${queue.length} items`);
    try {
      await queueWriter.write(queue);
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
      queueWriter.writeSync(queue);
      logger.info(`Saved queue with ${queue.length} items on close`);
      event.returnValue = { success: true };
    } catch (error) {
      logger.error('Error saving queue on close:', error);
      event.returnValue = { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Clear queue. Written empty rather than deleted: a save still in flight
  // would otherwise put the old queue back after the delete.
  ipcMain.handle('clear-queue', async () => {
    logger.info('Clearing queue');
    try {
      await queueWriter.write([]);
      logger.info('Queue cleared');
      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('Error clearing queue:', error);
      return { success: false, error: errorMsg };
    }
  });
}
