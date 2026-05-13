import { ipcMain } from 'electron';
import { logger } from './logger';
import { configManager } from './configManager';
import { detectCudaSupport, pollGpuStats } from './utils';
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

  ipcMain.handle('get-gpu-stats', async () => {
    return await pollGpuStats();
  });

  ipcMain.handle('setup-dependencies',
    createIpcHandler(
      'setup-dependencies',
      async () => {
        await dependencyManager.setupDependencies();
        // Reload config after setup to get the stock config with model metadata
        await configManager.load();
        logger.info('Config reloaded after core setup');

        // Auto-install plugins as the final phase of unified setup.
        logger.info('Starting plugin install phase of unified setup');
        const pluginResult = await pluginInstaller.installDependenciesForSetup();
        if (!pluginResult.success) {
          logger.error(`Plugin install failed during setup: ${pluginResult.error}`);
          // pluginInstaller already emitted a setup-progress error event with
          // component='Plugins'. Return failure so the renderer can show recovery UI.
          return { success: false, error: pluginResult.error };
        }

        // Reload config again so any plugin-extracted templates/filters are picked up.
        await configManager.load();

        // Final unified setup completion event — fires only after BOTH phases succeed.
        pluginInstaller.emitSetupComplete();
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

  ipcMain.handle('retry-setup-plugins', async () => {
    logger.info('User-initiated retry of plugin install (setup mode)');
    try {
      const result = await pluginInstaller.installDependenciesForSetup();
      if (result.success) {
        await configManager.load();
        pluginInstaller.emitSetupComplete();
      }
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Error retrying plugin install:', errorMsg);
      return { success: false, error: errorMsg };
    }
  });
}
