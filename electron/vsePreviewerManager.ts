import * as path from 'path';
import * as fs from 'fs-extra';
import { spawn } from 'child_process';
import { PATHS } from './constants';
import { logger } from './logger';
import { setupVSEnvironment } from './utils';

/**
 * Manager for VSE-Previewer - VapourSynth script previewer tool
 * 
 * The VSE-Previewer allows users to preview VapourSynth scripts in real-time
 * with full playback controls and scrubbing capabilities. A bundled configuration
 * file (vse-previewer.conf) is automatically copied to the installation directory
 * during setup, which configures default preview settings like zoom mode and FPS limits.
 */
export class VsePreviewerManager {
  private static readonly VSE_PREVIEWER_DIR = PATHS.VS;
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
        const error = 'VSE-Previewer executable not found. Please run setup again to install required components.';
        logger.error(error);
        return { success: false, error };
      }
      
      // Check if script file exists
      if (!fs.existsSync(scriptPath)) {
        const error = `Script file not found at: ${scriptPath}. The VapourSynth script may have failed to generate.`;
        logger.error(error);
        return { success: false, error };
      }
      
      // Verify Python executable exists
      if (!fs.existsSync(PATHS.PYTHON)) {
        const error = 'Python executable not found. VapourSynth dependencies may not be installed correctly.';
        logger.error(error);
        return { success: false, error };
      }
      
      // Launch VSE-Previewer with the script
      // VSE-Previewer will auto-detect Python and VapourSynth since it's in the same directory
      logger.info(`Launching: ${this.VSE_PREVIEWER_EXE} -p ${scriptPath}`);
      
      const child = spawn(this.VSE_PREVIEWER_EXE, ['-p', scriptPath], {
        detached: true,
        stdio: 'pipe', // Capture output to detect launch errors
        cwd: this.VSE_PREVIEWER_DIR
      });
      
      // Create a promise to wait briefly and check if the process crashes immediately
      return new Promise((resolve) => {
        let errorOutput = '';
        
        // Collect stderr output
        child.stderr?.on('data', (data) => {
          errorOutput += data.toString();
        });
        
        // Check if the process exits immediately (indicates a launch failure)
        child.on('exit', (code, signal) => {
          if (code !== null && code !== 0) {
            const errorMsg = errorOutput 
              ? `VSE-Previewer failed to start: ${errorOutput.trim()}`
              : `VSE-Previewer exited with code ${code}. This may indicate a missing dependency or configuration issue.`;
            logger.error(errorMsg);
            resolve({ success: false, error: errorMsg });
          }
        });
        
        child.on('error', (err) => {
          const errorMsg = `Failed to spawn VSE-Previewer: ${err.message}`;
          logger.error(errorMsg);
          resolve({ success: false, error: errorMsg });
        });
        
        // If the process is still running after a short delay, consider it successful
        setTimeout(() => {
          // Detach the child process so it runs independently
          child.unref();
          logger.info('VSE-Previewer launched successfully');
          resolve({ success: true });
        }, 1000); // Wait 1 second to check for immediate failures
      });
    } catch (error) {
      logger.error('Error launching VSE-Previewer:', error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Unexpected error: ${errorMsg}` };
    }
  }
}
