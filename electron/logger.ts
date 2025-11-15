// electron/logger.ts
import log from 'electron-log';
import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Centralized logging utility for the application
 * Logs are stored in portable mode:
 * - Development: <project>/data/logs/main.log
 * - Production: <exe-directory>/data/logs/main.log
 * 
 * Log rotation:
 * - On startup, if main.log exceeds 15,000 lines, it's rotated to main_YYYY-MM-DDTHH-MM-SS.log
 * - A fresh main.log is then created for the new session
 */

// Configure log file location (portable)
const appDataPath = app.isPackaged 
  ? path.join(path.dirname(app.getPath('exe')), 'data')
  : path.join(app.getAppPath(), 'data');
const logPath = path.join(appDataPath, 'logs', 'main.log');

// Rotate log file if it exceeds 15,000 lines
const MAX_LOG_LINES = 15000;
let logRotated = false;
let rotatedBackupName = '';
try {
  if (fs.existsSync(logPath)) {
    const logContent = fs.readFileSync(logPath, 'utf-8');
    const lineCount = logContent.split('\n').length;
    
    if (lineCount > MAX_LOG_LINES) {
      // Create timestamped backup filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const backupName = `main_${timestamp}.log`;
      const backupPath = path.join(path.dirname(logPath), backupName);
      
      // Rename current log to backup
      fs.renameSync(logPath, backupPath);
      logRotated = true;
      rotatedBackupName = backupName;
    }
  }
} catch (error) {
  // If rotation fails, continue anyway - better to have logs than crash
  console.error('Failed to rotate log file:', error);
}

// Configure electron-log
log.transports.file.resolvePathFn = () => logPath;
log.transports.file.level = process.env.NODE_ENV === 'development' ? 'debug' : 'info';
log.transports.file.maxSize = 10 * 1024 * 1024; // 10MB
log.transports.console.level = process.env.NODE_ENV === 'development' ? 'debug' : 'info';

// Add timestamp format
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';
log.transports.console.format = '[{h}:{i}:{s}.{ms}] [{level}] {text}';

// Developer mode state
let developerMode = false;
let mainWindowRef: BrowserWindow | null = null;

// Log application start
log.info('='.repeat(80));
log.info(`Vapourkit v${app.getVersion()} - Starting`);
log.info(`Environment: ${process.env.NODE_ENV || 'production'}`);
log.info(`Platform: ${process.platform} ${process.arch}`);
log.info(`Electron: ${process.versions.electron}`);
log.info(`Node: ${process.versions.node}`);
log.info(`Log file: ${logPath}`);
if (logRotated) {
  log.info(`Previous log exceeded ${MAX_LOG_LINES} lines - rotated to ${rotatedBackupName}`);
}
log.info('='.repeat(80));

// Helper to format log messages with arguments
const formatMessage = (message: string, args: any[]): string => {
  return args.length > 0 
    ? `${message} ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}` 
    : message;
};

// Function to send log to renderer (always sends, UI components decide whether to display)
const sendToRenderer = (level: string, message: string, ...args: any[]) => {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send('dev-console-log', {
      level,
      message: formatMessage(message, args),
      timestamp: new Date().toISOString()
    });
  }
};

export const logger = {
  info: (message: string, ...args: any[]) => {
    log.info(message, ...args);
    sendToRenderer('info', message, ...args);
  },
  warn: (message: string, ...args: any[]) => {
    log.warn(message, ...args);
    sendToRenderer('warn', message, ...args);
  },
  error: (message: string, ...args: any[]) => {
    log.error(message, ...args);
    sendToRenderer('error', message, ...args);
  },
  
  // Error with user dialog notification
  errorWithDialog: (title: string, message: string, ...args: any[]) => {
    log.error(message, ...args);
    sendToRenderer('error', message, ...args);
    
    // Show error dialog to user
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      const { dialog } = require('electron');
      dialog.showErrorBox(title, formatMessage(message, args));
    }
  },
  debug: (message: string, ...args: any[]) => {
    log.debug(message, ...args);
    sendToRenderer('debug', message, ...args);
  },
  
  // Specialized logging methods
  dependency: (message: string, ...args: any[]) => {
    log.info(`[DEPENDENCY] ${message}`, ...args);
    sendToRenderer('info', `[DEPENDENCY] ${message}`, ...args);
  },
  upscale: (message: string, ...args: any[]) => {
    log.info(`[UPSCALE] ${message}`, ...args);
    sendToRenderer('info', `[UPSCALE] ${message}`, ...args);
  },
  model: (message: string, ...args: any[]) => {
    log.info(`[MODEL] ${message}`, ...args);
    sendToRenderer('info', `[MODEL] ${message}`, ...args);
  },
  
  // Get log file path for user access
  getLogPath: () => logPath,
  
  // Get logs directory
  getLogsDir: () => path.dirname(logPath),
  
  // Log separator for major operations
  separator: () => {
    log.info('-'.repeat(80));
    sendToRenderer('info', '-'.repeat(80));
  },
  
  // Developer mode control
  setDeveloperMode: (enabled: boolean, window: BrowserWindow | null) => {
    developerMode = enabled;
    mainWindowRef = window;
    log.info(`Developer mode ${enabled ? 'enabled' : 'disabled'}`);
    // Note: Persistence is handled by configManager in main.ts
  },
  
  getDeveloperMode: () => developerMode,
  
  // Initialize developer mode from config
  initializeDeveloperMode: (enabled: boolean, window: BrowserWindow | null) => {
    developerMode = enabled;
    mainWindowRef = window;
  }
};

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  log.error('Uncaught Exception:', error);
  sendToRenderer('error', `Uncaught Exception: ${error.message}`, error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  log.error('Unhandled Rejection at:', promise, 'reason:', reason);
  sendToRenderer('error', `Unhandled Rejection: ${reason}`);
});

export default logger;