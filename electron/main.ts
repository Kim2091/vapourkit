import { app, dialog, protocol } from 'electron';
import * as path from 'path';
import { logger } from './logger';
import { configManager } from './configManager';
import { WindowManager } from './windowManager';
import { registerAllIpcHandlers } from './ipcRegistry';

// ============================================================================
// INITIALIZATION
// ============================================================================

const windowManager = new WindowManager();

// Set portable userData path (makes localStorage local to installation)
if (app.isPackaged) {
  const portableUserDataPath = path.join(path.dirname(app.getPath('exe')), 'data', 'user-data');
  app.setPath('userData', portableUserDataPath);
  logger.info(`Using portable userData path: ${portableUserDataPath}`);
}

// Load config and initialize developer mode
configManager.load().then(() => {
  const devMode = configManager.getDeveloperMode();
  logger.initializeDeveloperMode(devMode, windowManager.getWindow());
  logger.info(`Developer mode initialized: ${devMode}`);
});

// ============================================================================
// APP LIFECYCLE
// ============================================================================

app.whenReady().then(() => {
  logger.info('App ready, registering protocols');
  
  // Register custom video protocol
  protocol.registerFileProtocol('video', (request, callback) => {
    const url = request.url.replace('video://', '');
    const decodedPath = decodeURIComponent(url);
    logger.debug(`Video protocol request: ${decodedPath}`);
    callback({ path: decodedPath });
  });

  // Create the main window
  const mainWindow = windowManager.createWindow();
  const managers = windowManager.getManagers();

  // Register all IPC handlers
  if (managers) {
    registerAllIpcHandlers(
      mainWindow,
      managers.dependencyManager,
      managers.scriptGenerator,
      managers.templateManager,
      managers.pluginInstaller
    );
    logger.info('All IPC handlers registered');
  }
});

// ============================================================================
// ERROR HANDLING
// ============================================================================

// Global error handler for main process
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
  dialog.showErrorBox('Error', error.message || 'An unknown error occurred');
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
  const message = reason instanceof Error ? reason.message : String(reason);
  dialog.showErrorBox('Error', message || 'An unknown error occurred');
});

// ============================================================================
// APP LIFECYCLE EVENTS
// ============================================================================

app.on('window-all-closed', () => {
  logger.info('All windows closed');
  if (process.platform !== 'darwin') {
    logger.info('Quitting application');
    app.quit();
  }
});

app.on('activate', () => {
  logger.info('App activated');
  if (windowManager.getWindow() === null) {
    windowManager.createWindow();
  }
});
