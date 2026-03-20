import './asarFix'; // Must be first — fixes 7zip-bin path before any module imports 7zip-min
import { app, dialog, protocol } from 'electron';
import * as path from 'path';
import { logger } from './logger';
import { configManager } from './configManager';
import { WindowManager } from './windowManager';
import { registerAllIpcHandlers } from './ipcRegistry';
import { cancelActiveModelOperation } from './modelHandlers';
import { cancelAllVideoProcessing } from './videoHandlers';

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

// Load config
configManager.load().then(() => {
  logger.setMainWindow(windowManager.getWindow());
  logger.info('Config loaded');
});

// ============================================================================
// APP LIFECYCLE
// ============================================================================

app.whenReady().then(() => {
  logger.info('App ready, registering protocols');
  
  // Register custom video protocol
  protocol.registerFileProtocol('video', (request, callback) => {
    let url = request.url.replace('video://', '');
    // Strip query parameters (used for cache busting)
    const queryIndex = url.indexOf('?');
    if (queryIndex !== -1) {
      url = url.substring(0, queryIndex);
    }
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
  // Removed dialog.showErrorBox to prevent focus stealing issues
  // Critical errors are logged and can be reviewed in log files
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
  // Removed dialog.showErrorBox to prevent focus stealing issues
  // Critical errors are logged and can be reviewed in log files
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

app.on('before-quit', () => {
  logger.info('App quitting, cleaning up child processes');
  // Cancel any active model operations (trtexec processes)
  cancelActiveModelOperation();
  // Cancel any active video processing (vspipe, ffmpeg processes)
  cancelAllVideoProcessing();
});

app.on('activate', () => {
  logger.info('App activated');
  if (windowManager.getWindow() === null) {
    windowManager.createWindow();
  }
});
