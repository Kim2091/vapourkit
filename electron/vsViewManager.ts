import * as path from 'path';
import * as fs from 'fs-extra';
import { spawn } from 'child_process';
import { PATHS, PYPI_EXTRA_INDEX_ARGS, VSVIEW_MIN_VERSION } from './constants';
import { logger } from './logger';
import { setupVSEnvironment } from './utils';
import { isUpdateAvailable } from './updateChecker';

/**
 * Manager for vs-view - VapourSynth script previewer tool
 * 
 * vs-view is a Python package that provides real-time preview capabilities
 * for VapourSynth scripts with playback controls and scrubbing.
 * It should be installed via pip in the VapourSynth Python environment.
 */
export class VsViewManager {
  /**
   * vsview is a separate PySide6/Qt GUI. An AppImage exports Electron's Qt
   * and shared-library paths to all child processes; if inherited, Qt can load
   * Electron's incompatible plugins instead of the PySide6 wheel's plugins
   * and exit without ever showing a window. Keep the VapourSynth environment,
   * but remove AppImage/Electron loader overrides for this external GUI.
   */
  static createGuiEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const guiEnvironment = { ...environment };
    for (const variable of [
      'LD_LIBRARY_PATH',
      'LD_PRELOAD',
      'QT_PLUGIN_PATH',
      'QT_QPA_PLATFORM_PLUGIN_PATH',
      'ELECTRON_RUN_AS_NODE',
    ]) {
      delete guiEnvironment[variable];
    }
    return guiEnvironment;
  }

  /**
   * Check if vs-view is installed and at least VSVIEW_MIN_VERSION.
   * An older install reports false so the launch path upgrades it.
   */
  static async isInstalled(): Promise<boolean> {
    try {
      const env = setupVSEnvironment();

      const child = spawn(PATHS.PYTHON, ['-m', 'pip', 'list', '--format=json'], {
        env,
        cwd: PATHS.VS
      });

      return new Promise((resolve) => {
        let output = '';

        child.stdout?.on('data', (data) => {
          output += data.toString();
        });

        child.on('close', (code) => {
          if (code !== 0) {
            resolve(false);
            return;
          }
          try {
            // Exact-name match: the plugin packages (vsview-comp, ...) also
            // contain "vsview", so a substring check would false-positive
            const packages: { name: string; version: string }[] = JSON.parse(output);
            const vsview = packages.find(pkg => pkg.name.toLowerCase() === 'vsview');
            if (!vsview) {
              resolve(false);
              return;
            }
            if (isUpdateAvailable(vsview.version, VSVIEW_MIN_VERSION)) {
              logger.info(`vsview ${vsview.version} is older than required ${VSVIEW_MIN_VERSION}`);
              resolve(false);
              return;
            }
            resolve(true);
          } catch (error) {
            logger.error('Error parsing pip list output:', error);
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

      // vsview normally arrives with the main plugin install (vsview[full]);
      // this is the fallback path when it's missing or below the version floor.
      // Some of its dependencies are hosted on the JET wheels index rather
      // than PyPI.
      const child = spawn(PATHS.PYTHON, ['-m', 'pip', 'install', '--upgrade', '--no-warn-script-location', `vsview[full]>=${VSVIEW_MIN_VERSION}`, ...PYPI_EXTRA_INDEX_ARGS], {
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

      // Check if vs-view is installed and recent enough
      const isInstalled = await this.isInstalled();
      if (!isInstalled) {
        logger.info('vs-view missing or outdated, attempting to install...');
        const installResult = await this.install();
        if (!installResult.success) {
          return { success: false, error: installResult.error };
        }
      }
      
      // Setup environment for VapourSynth
      const env = setupVSEnvironment();

      // Use the pip-generated console_scripts wrapper directly (launching via
      // `python -m vsview` has historically been unreliable).
      const vsviewExe = PATHS.VSVIEW_EXE;
      if (!fs.existsSync(vsviewExe)) {
        const error = `vs-view executable not found at: ${vsviewExe}. The pip install may not have completed.`;
        logger.error(error);
        return { success: false, error };
      }

      logger.info(`Launching: ${vsviewExe} ${scriptPath}`);

      const guiEnv = this.createGuiEnvironment(env);
      logger.info(`Launching vs-view with isolated GUI environment (AppImage: ${Boolean(process.env.APPIMAGE)})`);
      const child = spawn(vsviewExe, [scriptPath], {
        detached: true,
        stdio: 'pipe',
        cwd: PATHS.VS,
        env: guiEnv,
      });
      
      // Wait briefly for an immediate GUI startup failure. `child.killed` only
      // means kill() was called; it remains false after a clean early exit, so
      // using it here falsely reported a successfully launched window.
      return new Promise((resolve) => {
        let errorOutput = '';
        let output = '';
        let exited = false;
        let settled = false;

        const finish = (result: { success: boolean; error?: string }) => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        
        child.stdout?.on('data', (data) => {
          const text = data.toString();
          output += text;
          logger.info(`[vs-view] ${text.trimEnd()}`);
        });

        child.stderr?.on('data', (data) => {
          const text = data.toString();
          errorOutput += text;
          logger.error(`[vs-view] ${text.trimEnd()}`);
        });
        
        child.on('exit', (code, signal) => {
          exited = true;
          const details = (errorOutput || output).trim();
          const status = signal ? `signal ${signal}` : `code ${code}`;
          const errorMsg = details
            ? `vs-view exited before opening its window (${status}): ${details}`
            : `vs-view exited before opening its window (${status}). Check that a graphical desktop session is available.`;
          logger.error(errorMsg);
          finish({ success: false, error: errorMsg });
        });
        
        child.on('error', (err) => {
          const errorMsg = `Failed to launch vs-view: ${err.message}`;
          logger.error(errorMsg);
          finish({ success: false, error: errorMsg });
        });
        
        setTimeout(() => {
          if (!exited) {
            logger.info('vs-view process started successfully');
            child.unref();
            finish({ success: true });
          }
        }, 3000);
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('Error launching vs-view:', error);
      return { success: false, error: errorMsg };
    }
  }
}
