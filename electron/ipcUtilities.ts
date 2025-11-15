import { BrowserWindow } from 'electron';
import { logger } from './logger';
import { withLogSeparator } from './utils';

/**
 * Wraps an IPC handler with standard error handling and logging
 */
export function createIpcHandler<T>(
  handlerName: string,
  handler: () => Promise<T>,
  options: { 
    logResult?: boolean;
    throwOnError?: boolean;
    useLogSeparator?: boolean;
  } = {}
): () => Promise<T | { success: false; error: string }> {
  const { logResult = false, throwOnError = false, useLogSeparator = false } = options;
  
  const wrappedHandler = async () => {
    logger.info(`IPC Handler: ${handlerName}`);
    try {
      const result = await handler();
      if (logResult) {
        logger.info(`${handlerName} completed:`, result);
      } else {
        logger.info(`${handlerName} completed successfully`);
      }
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`${handlerName} failed:`, errorMsg);
      
      if (throwOnError) {
        throw error;
      }
      
      return { success: false, error: errorMsg } as any;
    }
  };
  
  return useLogSeparator ? () => withLogSeparator(wrappedHandler) : wrappedHandler;
}

/**
 * Sends progress updates for model import
 */
export function sendModelImportProgress(
  mainWindow: BrowserWindow | null,
  type: 'validating' | 'copying' | 'converting' | 'complete' | 'error',
  progress: number,
  message: string,
  enginePath?: string
) {
  mainWindow?.webContents.send('model-import-progress', {
    type,
    progress,
    message,
    enginePath
  });
}

/**
 * Handles dialog result with cancellation check
 */
export function handleDialogResult<T>(
  result: { canceled: boolean; filePath?: string; filePaths?: string[] },
  logContext: string
): T | null {
  if (result.canceled) {
    logger.info(`${logContext} canceled`);
    return null;
  }
  
  const selectedPath = result.filePath || (result.filePaths && result.filePaths[0]);
  if (selectedPath) {
    logger.info(`${logContext} selected: ${selectedPath}`);
    return selectedPath as T;
  }
  
  return null;
}

/**
 * Formats bytes to human-readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}
