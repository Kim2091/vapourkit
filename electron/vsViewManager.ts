import * as path from 'path';
import * as fs from 'fs-extra';
import { spawn } from 'child_process';
import { PATHS } from './constants';
import { logger } from './logger';
import { setupVSEnvironment } from './utils';

/**
 * Manager for vs-preview - VapourSynth script previewer tool
 * 
 * vs-preview is a Python package that provides real-time preview capabilities
 * for VapourSynth scripts with playback controls and scrubbing.
 * It should be installed via pip in the VapourSynth Python environment.
 */
export class VsViewManager {
  /**
   * Check if vs-preview is installed in the Python environment
   */
  static async isInstalled(): Promise<boolean> {
    try {
      const env = setupVSEnvironment();
      
      // Check if vspreview is installed by running pip list
      const child = spawn(PATHS.PYTHON, ['-m', 'pip', 'list'], {
        env,
        cwd: PATHS.VS
      });
      
      return new Promise((resolve) => {
        let output = '';
        
        child.stdout?.on('data', (data) => {
          output += data.toString();
        });
        
        child.on('close', (code) => {
          if (code === 0) {
            // Check if vspreview is in the pip list output
            const isInstalled = output.toLowerCase().includes('vspreview');
            resolve(isInstalled);
          } else {
            resolve(false);
          }
        });
        
        child.on('error', () => {
          resolve(false);
        });
      });
    } catch (error) {
      logger.error('Error checking vs-preview installation:', error);
      return false;
    }
  }
  
  /**
   * Install vs-preview using pip
   */
  static async install(): Promise<{ success: boolean; error?: string }> {
    logger.info('Installing vs-preview via pip...');
    
    try {
      const env = setupVSEnvironment();
      
      // Install vspreview==0.19.0
      const child = spawn(PATHS.PYTHON, ['-m', 'pip', 'install', 'vspreview==0.19.0'], {
        env,
        cwd: PATHS.VS,
        stdio: 'pipe'
      });
      
      return new Promise((resolve) => {
        let errorOutput = '';
        
        child.stderr?.on('data', (data) => {
          errorOutput += data.toString();
          logger.info(data.toString());
        });
        
        child.stdout?.on('data', (data) => {
          logger.info(data.toString());
        });
        
        child.on('close', (code) => {
          if (code === 0) {
            logger.info('vs-preview installed successfully');
            resolve({ success: true });
          } else {
            const error = `vs-preview installation failed with code ${code}: ${errorOutput}`;
            logger.error(error);
            resolve({ success: false, error });
          }
        });
        
        child.on('error', (err) => {
          const error = `Failed to install vs-preview: ${err.message}`;
          logger.error(error);
          resolve({ success: false, error });
        });
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('Error installing vs-preview:', error);
      return { success: false, error: errorMsg };
    }
  }
  
  /**
   * Launch vs-preview with a VapourSynth script
   * @param scriptPath Path to the .vpy script file
   */
  static async launch(scriptPath: string): Promise<{ success: boolean; error?: string }> {
    logger.info(`Launching vs-preview with script: ${scriptPath}`);
    
    try {
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
      
      // Check if vs-preview is installed
      const isInstalled = await this.isInstalled();
      if (!isInstalled) {
        logger.info('vs-preview not found, attempting to install...');
        const installResult = await this.install();
        if (!installResult.success) {
          return { success: false, error: installResult.error };
        }
      }
      
      // Setup environment for VapourSynth
      const env = setupVSEnvironment();
      
      // Launch vs-preview with the script
      logger.info(`Launching: vspreview ${scriptPath}`);
      
      const child = spawn(PATHS.PYTHON, ['-m', 'vspreview', scriptPath], {
        detached: true,
        stdio: 'pipe', // Capture output to detect launch errors
        cwd: PATHS.VS,
        env
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
              ? `vs-preview failed to start: ${errorOutput.trim()}`
              : `vs-preview exited with code ${code}. This may indicate a missing dependency or configuration issue.`;
            logger.error(errorMsg);
            resolve({ success: false, error: errorMsg });
          }
        });
        
        child.on('error', (err) => {
          const errorMsg = `Failed to launch vs-preview: ${err.message}`;
          logger.error(errorMsg);
          resolve({ success: false, error: errorMsg });
        });
        
        // If process is still running after 2 seconds, assume success
        setTimeout(() => {
          if (!child.killed) {
            logger.info('vs-preview process started successfully');
            child.unref(); // Allow parent process to exit independently
            resolve({ success: true });
          }
        }, 2000);
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('Error launching vs-preview:', error);
      return { success: false, error: errorMsg };
    }
  }
}
