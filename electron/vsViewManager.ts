import * as path from 'path';
import * as fs from 'fs-extra';
import { spawn } from 'child_process';
import { PATHS, PYPI_EXTRA_INDEX_ARGS, VSVIEW_MIN_VERSION } from './constants';
import { logger } from './logger';
import { setupVSEnvironment } from './utils';
import { resolveRocmRoot } from './rocmEnvironment';
import { isUpdateAvailable } from './updateChecker';
import { pipInstall, pipList, pipUninstall } from './pip';

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
    // The AppImage's loader paths go, but the ROCm install chosen in Settings
    // is the user's own and the MIGraphX plugin needs it (rocmEnvironment.ts)
    const rocmRoot = resolveRocmRoot(undefined, environment);
    if (rocmRoot) {
      guiEnvironment['LD_LIBRARY_PATH'] = path.join(rocmRoot, 'lib');
    }
    return guiEnvironment;
  }

  /**
   * Check if vs-view is installed and at least VSVIEW_MIN_VERSION.
   * An older install reports false so the launch path upgrades it.
   */
  static async isInstalled(): Promise<boolean> {
    const packages = await pipList();
    if (!packages) return false;
    // Exact-name match: the plugin packages (vsview-comp, ...) also
    // contain "vsview", so a substring check would false-positive
    const vsview = packages.find(pkg => pkg.name.toLowerCase() === 'vsview');
    if (!vsview) return false;
    if (isUpdateAvailable(vsview.version, VSVIEW_MIN_VERSION)) {
      logger.info(`vsview ${vsview.version} is older than required ${VSVIEW_MIN_VERSION}`);
      return false;
    }
    return true;
  }

  /**
   * Install vs-view using pip
   */
  static async install(): Promise<{ success: boolean; error?: string }> {
    logger.info('Installing vs-view via pip...');
    // vsview normally arrives with the main plugin install (vsview[full]);
    // this is the fallback path when it's missing or below the version floor.
    // Some of its dependencies are hosted on the JET wheels index rather
    // than PyPI.
    const outcome = await pipInstall([`vsview[full]>=${VSVIEW_MIN_VERSION}`], {
      step: 'Installing vs-view',
      extraArgs: ['--upgrade', ...PYPI_EXTRA_INDEX_ARGS],
    });
    if (outcome.ok) {
      logger.info('vs-view installed successfully');
      return { success: true };
    }
    return { success: false, error: outcome.failure?.summary ?? 'vs-view installation was cancelled' };
  }

  /**
   * Detect a leftover vs-preview install from a prior build and uninstall it.
   * Runs before the vs-view install check so upgrading users migrate cleanly.
   */
  static async migrateFromVsPreview(): Promise<void> {
    const packages = await pipList();
    if (!packages?.some(pkg => pkg.name.toLowerCase() === 'vspreview')) return;

    logger.info('Detected vs-preview from a prior build, uninstalling...');
    const outcome = await pipUninstall(['vspreview'], { step: 'Uninstalling vs-preview' });
    if (outcome.ok) {
      logger.info('vs-preview uninstalled successfully');
    } else {
      logger.warn(`vs-preview uninstall failed (exit code ${outcome.exitCode}); continuing`);
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
          // vs-view writes its ordinary progress and plugin warnings to stderr;
          // whether the launch failed is decided by the exit below, not here.
          logger.info(`[vs-view] ${text.trimEnd()}`);
        });
        
        child.on('exit', (code, signal) => {
          exited = true;
          // Past the startup window, an exit is the person closing it.
          if (settled) {
            logger.info(`vs-view closed (${signal ? `signal ${signal}` : `code ${code}`})`);
            return;
          }
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
