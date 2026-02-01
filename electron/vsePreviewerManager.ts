import * as path from 'path';
import * as fs from 'fs-extra';
import { spawn } from 'child_process';
import { PATHS } from './constants';
import { logger } from './logger';
import { setupVSEnvironment } from './utils';

/**
 * Manager for VSE-Previewer - VapourSynth script previewer tool
 */
export class VsePreviewerManager {
  private static readonly VSE_PREVIEWER_DIR = path.join(PATHS.APP_DATA, 'vse-previewer');
  private static readonly VSE_PREVIEWER_EXE = path.join(this.VSE_PREVIEWER_DIR, 'vse-previewer.exe');
  
  /**
   * Check if VSE-Previewer is installed
   */
  static isInstalled(): boolean {
    return fs.existsSync(this.VSE_PREVIEWER_EXE);
  }
  
  /**
   * Get the path to the VSE-Previewer executable
   */
  static getExePath(): string {
    return this.VSE_PREVIEWER_EXE;
  }
  
  /**
   * Get the installation directory
   */
  static getInstallDir(): string {
    return this.VSE_PREVIEWER_DIR;
  }
  
  /**
   * Launch VSE-Previewer with a VapourSynth script
   * @param scriptPath Path to the .vpy script file
   */
  static async launch(scriptPath: string): Promise<{ success: boolean; error?: string }> {
    logger.info(`Launching VSE-Previewer with script: ${scriptPath}`);
    
    try {
      // Check if VSE-Previewer exists
      if (!this.isInstalled()) {
        throw new Error('VSE-Previewer not found. Please run setup again.');
      }
      
      // Check if script file exists
      if (!fs.existsSync(scriptPath)) {
        throw new Error(`Script file not found: ${scriptPath}`);
      }
      
      // Setup VapourSynth environment (VSE-Previewer needs access to Python and VS plugins)
      const env = setupVSEnvironment(PATHS.PYTHON);
      
      // Launch VSE-Previewer with the script
      logger.info(`Launching: ${this.VSE_PREVIEWER_EXE} -p ${scriptPath}`);
      
      const child = spawn(this.VSE_PREVIEWER_EXE, ['-p', scriptPath], {
        detached: true,
        stdio: 'ignore',
        cwd: this.VSE_PREVIEWER_DIR,
        env: env  // Pass VapourSynth environment
      });
      
      // Detach the child process so it runs independently
      child.unref();
      
      logger.info('VSE-Previewer launched successfully');
      return { success: true };
    } catch (error) {
      logger.error('Error launching VSE-Previewer:', error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMsg };
    }
  }
}
