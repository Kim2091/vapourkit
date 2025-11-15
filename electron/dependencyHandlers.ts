import { ipcMain } from 'electron';
import { logger } from './logger';
import { configManager } from './configManager';
import { detectCudaSupport } from './utils';
import { createIpcHandler } from './ipcUtilities';
import { DependencyManager } from './dependencyManager';
import { PluginInstaller } from './pluginInstaller';

/**
 * Registers all dependency and plugin-related IPC handlers
 */
export function registerDependencyHandlers(
  dependencyManager: DependencyManager,
  pluginInstaller: PluginInstaller
) {
  ipcMain.handle('check-dependencies', 
    createIpcHandler(
      'check-dependencies',
      () => dependencyManager.checkDependencies(),
      { logResult: true, throwOnError: true }
    )
  );

  ipcMain.handle('detect-cuda-support', 
    createIpcHandler(
      'detect-cuda-support',
      async () => {
        const hasCuda = await detectCudaSupport();
        logger.info(`CUDA detection result: ${hasCuda}`);
        return hasCuda;
      },
      { logResult: true }
    )
  );

  ipcMain.handle('setup-dependencies',
    createIpcHandler(
      'setup-dependencies',
      async () => {
        await dependencyManager.setupDependencies();
        // Reload config after setup to get the stock config with model metadata
        await configManager.load();
        logger.info('Config reloaded after setup');
        return { success: true };
      },
      { useLogSeparator: true }
    )
  );

  // Plugin dependency handlers
  ipcMain.handle('install-plugin-dependencies', async () => {
    logger.info('Installing plugin dependencies');
    try {
      const result = await pluginInstaller.installDependencies();
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Error installing plugin dependencies:', errorMsg);
      return { success: false, error: errorMsg };
    }
  });

  ipcMain.handle('uninstall-plugin-dependencies', async () => {
    logger.info('Uninstalling plugin dependencies');
    try {
      const result = await pluginInstaller.uninstallDependencies();
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Error uninstalling plugin dependencies:', errorMsg);
      return { success: false, error: errorMsg };
    }
  });

  ipcMain.handle('check-plugin-dependencies', async () => {
    logger.info('Checking plugin dependencies');
    try {
      const result = await pluginInstaller.checkInstalled();
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Error checking plugin dependencies:', errorMsg);
      return { installed: false, packages: [] };
    }
  });

  ipcMain.handle('cancel-plugin-dependency-install', async () => {
    logger.info('Cancelling plugin dependency operation');
    pluginInstaller.cancel();
    return { success: true };
  });
}
