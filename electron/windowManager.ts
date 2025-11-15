import { BrowserWindow } from 'electron';
import * as path from 'path';
import { logger } from './logger';
import { DependencyManager } from './dependencyManager';
import { VapourSynthScriptGenerator } from './scriptGenerator';
import { TemplateManager } from './templateManager';
import { PluginInstaller } from './pluginInstaller';

export interface WindowManagers {
  dependencyManager: DependencyManager;
  scriptGenerator: VapourSynthScriptGenerator;
  templateManager: TemplateManager;
  pluginInstaller: PluginInstaller;
}

export class WindowManager {
  private window: BrowserWindow | null = null;
  private managers: WindowManagers | null = null;

  createWindow(): BrowserWindow {
    logger.info('Creating main window');
    
    this.window = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 900,
      minHeight: 600,
      backgroundColor: '#0a0e1a',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js')
      },
      frame: true,
      titleBarStyle: 'default',
      autoHideMenuBar: true
    });

    if (process.env.NODE_ENV === 'development') {
      logger.info('Loading development URL: http://localhost:5173');
      this.window.loadURL('http://localhost:5173');
      this.window.webContents.openDevTools();
    } else {
      const indexPath = path.join(__dirname, '../renderer/index.html');
      logger.info(`Loading production file: ${indexPath}`);
      this.window.loadFile(indexPath);
    }

    this.window.on('closed', () => {
      logger.info('Main window closed');
      this.window = null;
      this.managers = null;
    });

    // Initialize managers
    this.managers = {
      dependencyManager: new DependencyManager(this.window),
      scriptGenerator: new VapourSynthScriptGenerator(),
      templateManager: new TemplateManager(),
      pluginInstaller: new PluginInstaller(this.window)
    };
    
    logger.info('Managers initialized');
    
    // Initialize default templates
    this.managers.templateManager.createDefaultTemplates().catch(err => {
      logger.error('Error creating default templates:', err);
    });

    return this.window;
  }

  getWindow(): BrowserWindow | null {
    return this.window;
  }

  getManagers(): WindowManagers | null {
    return this.managers;
  }
}
