import * as path from 'path';
import * as fs from 'fs-extra';
import { spawn } from 'child_process';
import { PATHS } from './constants';
import { logger } from './logger';
import { setupVSEnvironment } from './utils';

/**
 * Manager for vs-view - VapourSynth script previewer tool
 * 
 * vs-view is a Python package that provides real-time preview capabilities
 * for VapourSynth scripts with playback controls and scrubbing.
 * It should be installed via pip in the VapourSynth Python environment.
 */
export class VsViewManager {
  /**
   * Check if vs-view is installed in the Python environment
   */
  static async isInstalled(): Promise<boolean> {
    try {
      const env = setupVSEnvironment();
      
      // Check if vsview is installed by running pip list
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
            // Check if vsview is in the pip list output
            const isInstalled = output.toLowerCase().includes('vsview');
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
      logger.error('Error checking vs-view installation:', error);
      return false;
    }
  }
  
  /**
   * Install vs-view using pip
   */
  static async install(): Promise<{ success: boolean; error?: string }> {
    logger.info('Installing vs-view via pip...');
    
    try {
      const env = setupVSEnvironment();
      
      // Install vsview==0.5.0
      const child = spawn(PATHS.PYTHON, ['-m', 'pip', 'install', 'vsview==0.5.0'], {
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
            logger.info('vs-view installed successfully');
            resolve({ success: true });
          } else {
            const error = `vs-view installation failed with code ${code}: ${errorOutput}`;
            logger.error(error);
            resolve({ success: false, error });
          }
        });
        
        child.on('error', (err) => {
          const error = `Failed to install vs-view: ${err.message}`;
          logger.error(error);
          resolve({ success: false, error });
        });
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('Error installing vs-view:', error);
      return { success: false, error: errorMsg };
    }
  }
  
  /**
   * Detect a leftover vs-preview install from a prior build and uninstall it.
   * Runs before the vs-view install check so upgrading users migrate cleanly.
   */
  static async migrateFromVsPreview(): Promise<void> {
    try {
      const env = setupVSEnvironment();

      const listChild = spawn(PATHS.PYTHON, ['-m', 'pip', 'list'], {
        env,
        cwd: PATHS.VS
      });

      const hasVsPreview = await new Promise<boolean>((resolve) => {
        let output = '';
        listChild.stdout?.on('data', (data) => { output += data.toString(); });
        listChild.on('close', (code) => {
          resolve(code === 0 && output.toLowerCase().includes('vspreview'));
        });
        listChild.on('error', () => resolve(false));
      });

      if (!hasVsPreview) return;

      logger.info('Detected vs-preview from a prior build, uninstalling...');

      const uninstallChild = spawn(PATHS.PYTHON, ['-m', 'pip', 'uninstall', '-y', 'vspreview'], {
        env,
        cwd: PATHS.VS,
        stdio: 'pipe'
      });

      await new Promise<void>((resolve) => {
        uninstallChild.stderr?.on('data', (data) => logger.info(data.toString()));
        uninstallChild.stdout?.on('data', (data) => logger.info(data.toString()));
        uninstallChild.on('close', (code) => {
          if (code === 0) {
            logger.info('vs-preview uninstalled successfully');
          } else {
            logger.warn(`vs-preview uninstall exited with code ${code}; continuing`);
          }
          resolve();
        });
        uninstallChild.on('error', (err) => {
          logger.warn(`Failed to uninstall vs-preview: ${err.message}; continuing`);
          resolve();
        });
      });
    } catch (error) {
      logger.warn('Error during vs-preview migration check, continuing:', error);
    }
  }

  /**
   * Launch vs-view with a VapourSynth script
   * @param scriptPath Path to the .vpy script file
   */
  static async launch(scriptPath: string): Promise<{ success: boolean; error?: string }> {
    logger.info(`Launching vs-view with script: ${scriptPath}`);

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

      // Uninstall vs-preview if present (from a prior build)
      await this.migrateFromVsPreview();

      // Check if vs-view is installed
      const isInstalled = await this.isInstalled();
      if (!isInstalled) {
        logger.info('vs-view not found, attempting to install...');
        const installResult = await this.install();
        if (!installResult.success) {
          return { success: false, error: installResult.error };
        }
      }
      
      // Setup environment for VapourSynth
      const env = setupVSEnvironment();

      // Use the pip-generated console_scripts wrapper directly.
      // `python -m vsview` does not work — the vsview package has no __main__.py;
      // its entry point is declared as `vsview = vsview.cli:main` in entry_points.txt,
      // which pip materializes as Scripts/vsview.exe.
      const vsviewExe = path.join(PATHS.VS, 'Scripts', 'vsview.exe');
      if (!fs.existsSync(vsviewExe)) {
        const error = `vs-view executable not found at: ${vsviewExe}. The pip install may not have completed.`;
        logger.error(error);
        return { success: false, error };
      }

      logger.info(`Launching: ${vsviewExe} ${scriptPath}`);

      const child = spawn(vsviewExe, [scriptPath], {
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
              ? `vs-view failed to start: ${errorOutput.trim()}`
              : `vs-view exited with code ${code}. This may indicate a missing dependency or configuration issue.`;
            logger.error(errorMsg);
            resolve({ success: false, error: errorMsg });
          }
        });
        
        child.on('error', (err) => {
          const errorMsg = `Failed to launch vs-view: ${err.message}`;
          logger.error(errorMsg);
          resolve({ success: false, error: errorMsg });
        });
        
        // If process is still running after 2 seconds, assume success
        setTimeout(() => {
          if (!child.killed) {
            logger.info('vs-view process started successfully');
            child.unref(); // Allow parent process to exit independently
            resolve({ success: true });
          }
        }, 2000);
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('Error launching vs-view:', error);
      return { success: false, error: errorMsg };
    }
  }
}
