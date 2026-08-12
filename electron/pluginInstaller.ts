// electron/pluginInstaller.ts
import { spawn, ChildProcess } from 'child_process';
import { BrowserWindow, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as https from 'https';
import { logger } from './logger';
import { PATHS, PYPI_EXTRA_INDEX_ARGS } from './constants';
import { configManager } from './configManager';
import { getBundledBasePath } from './utils';
import { createWorkloadSpawnOptions, terminateProcessTree } from './processLifecycle';
import {
  shouldCopyBundledPluginFilterTemplates,
  shouldExtractBundledPluginArchives,
} from './bundledPluginArchives';
import { removeSupersededPlugins, removeSupersededScripts, applyPluginCompatibilityFixes } from './legacyCleanup';
import { VsMlrtModelsManager } from './vsMlrtModelsManager';
import { ensureTrtexecShim } from './trtexecShim';
import { detectGpuVendor } from './gpuDetection';
import {
  computeVendorPurge,
  evaluateInstallState,
  getBackendPipPackages,
  getCheckPackageNames,
  getPypiPackages,
  getTorchInstall,
  normalizePackageName,
  UNINSTALL_PACKAGE_NAMES,
  type InstalledPackage,
} from './vendorPackages';
import * as _7z from '7zip-min';

export interface PluginDependencyProgress {
  type: 'installing' | 'complete' | 'error';
  progress: number;
  message: string;
}

interface SetupProgressEvent {
  type: 'installing' | 'complete' | 'error';
  component: string;
  progress: number;
  message: string;
}

export class PluginInstaller {
  private mainWindow: BrowserWindow | null;
  private installProcess: ChildProcess | null = null;
  private isCancelled: boolean = false;
  private useSetupChannel: boolean = false;

  constructor(mainWindow: BrowserWindow | null = null) {
    this.mainWindow = mainWindow;
  }

  private sendProgress(progress: PluginDependencyProgress) {
    if (!this.mainWindow) return;
    if (this.useSetupChannel) {
      const setupEvent: SetupProgressEvent = {
        type: progress.type,
        component: 'Plugins',
        progress: progress.progress,
        message: progress.message,
      };
      this.mainWindow.webContents.send('setup-progress', setupEvent);
    } else {
      this.mainWindow.webContents.send('plugin-dependency-progress', progress);
    }
  }

  private async runPipInstall(
    packages: string[],
    progressOffset: number,
    progressScale: number,
    extraArgs: string[] = []
  ): Promise<{ success: boolean; error?: string }> {
    const args = ['-m', 'pip', 'install', '--no-warn-script-location', '--cache-dir', PATHS.PIP_CACHE, ...packages, ...extraArgs];
    
    const commandStr = `${PATHS.PYTHON} ${args.join(' ')}`;
    logger.info(`Running command: ${commandStr}`);

    return new Promise((resolve) => {
      this.installProcess = spawn(PATHS.PYTHON, args, createWorkloadSpawnOptions({
        cwd: PATHS.VS,
        windowsHide: true
      }));

      let errorBuffer = '';
      let lastProgress = 0;
      let currentPackage = '';
      let currentStatus = 'Preparing...';
      let lineBuffer = '';

      const sendUpdate = (message: string, progressBoost: number = 0) => {
        lastProgress = Math.max(lastProgress, progressBoost);
        const scaledProgress = progressOffset + (lastProgress * progressScale / 100);
        this.sendProgress({
          type: 'installing',
          progress: Math.min(scaledProgress, 99),
          message
        });
      };

      const processLine = (line: string, source: 'stdout' | 'stderr') => {
        const trimmed = line.trim();
        if (!trimmed) return;

        // Log directly to file and console
        logger.info(`[pip] ${trimmed}`);

        // Extract package name from various pip messages
        let packageMatch = trimmed.match(/Collecting\s+([^\s(]+)/);
        if (packageMatch) {
          currentPackage = packageMatch[1];
          currentStatus = 'Collecting';
          sendUpdate(`Collecting ${currentPackage}...`, 10);
          return;
        }

        packageMatch = trimmed.match(/Downloading\s+([^\s(]+)/);
        if (packageMatch) {
          currentPackage = packageMatch[1];
          currentStatus = 'Downloading';
          sendUpdate(`Downloading ${currentPackage}...`, 30);
          return;
        }

        // Download progress with percentage
        const downloadProgress = trimmed.match(/(\d+)%/);
        if (downloadProgress && currentPackage) {
          const percent = parseInt(downloadProgress[1]);
          sendUpdate(`Downloading ${currentPackage}... ${percent}%`, 30 + (percent * 0.4));
          return;
        }

        // Installing collected packages
        if (trimmed.includes('Installing collected packages')) {
          const packagesMatch = trimmed.match(/Installing collected packages:\s*(.+)/);
          if (packagesMatch) {
            currentStatus = 'Installing';
            sendUpdate(`Installing packages: ${packagesMatch[1]}`, 80);
          } else {
            sendUpdate('Installing packages...', 80);
          }
          return;
        }

        // Successfully installed
        if (trimmed.includes('Successfully installed')) {
          const installedMatch = trimmed.match(/Successfully installed\s+(.+)/);
          if (installedMatch) {
            sendUpdate(`Successfully installed: ${installedMatch[1]}`, 95);
          } else {
            sendUpdate('Installation complete!', 95);
          }
          return;
        }

        // Requirement already satisfied
        if (trimmed.includes('Requirement already satisfied')) {
          const reqMatch = trimmed.match(/Requirement already satisfied:\s+([^\s]+)/);
          if (reqMatch) {
            sendUpdate(`${reqMatch[1]} already installed`, lastProgress);
          }
          return;
        }

        // Using cached package
        if (trimmed.includes('Using cached')) {
          const cachedMatch = trimmed.match(/Using cached\s+([^\s(]+)/);
          if (cachedMatch) {
            sendUpdate(`Using cached ${cachedMatch[1]}`, lastProgress);
          }
          return;
        }

        // Building wheel or preparing metadata
        if (trimmed.includes('Building wheel') || trimmed.includes('Preparing metadata')) {
          if (currentPackage) {
            sendUpdate(`Building ${currentPackage}...`, 60);
          } else {
            sendUpdate('Building packages...', 60);
          }
          return;
        }
      };

      this.installProcess.stdout?.on('data', (data: Buffer) => {
        const output = data.toString();
        lineBuffer += output;
        
        // Process complete lines
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || ''; // Keep incomplete line in buffer
        
        lines.forEach(line => processLine(line, 'stdout'));
      });

      this.installProcess.stderr?.on('data', (data: Buffer) => {
        const output = data.toString();
        errorBuffer += output;
        
        // Process stderr lines (pip often outputs progress to stderr)
        const lines = output.split('\n');
        lines.forEach(line => processLine(line, 'stderr'));
      });

      this.installProcess.on('close', (code: number | null) => {
        // Process any remaining buffered line
        if (lineBuffer.trim()) {
          processLine(lineBuffer, 'stdout');
        }
        
        this.installProcess = null;

        if (this.isCancelled) {
          logger.info('Plugin dependency installation cancelled');
          resolve({ success: false, error: 'Installation cancelled by user' });
          return;
        }

        if (code === 0) {
          logger.info('Pip install completed successfully');
          logger.info('✓ Step completed successfully');
          resolve({ success: true });
        } else {
          const errorMsg = `Installation failed with exit code ${code}`;
          logger.error(errorMsg);
          if (errorBuffer.trim()) {
            logger.error('Error output:');
            errorBuffer.split('\n').forEach(line => {
              if (line.trim()) logger.error(`  ${line}`);
            });
          }
          resolve({ success: false, error: errorMsg });
        }
      });

      this.installProcess.on('error', (error: Error) => {
        logger.error('Failed to start pip process:', error);
        resolve({ success: false, error: error.message });
      });
    });
  }

  /**
   * Reads the installed distributions from `pip list`, with names normalized
   * (PEP 503) once. Shared by the vendor purge and checkInstalled; an
   * unreadable environment resolves to an empty list, which reads as
   * "nothing installed" (matching the previous checkInstalled failure path).
   */
  private async listInstalledPackages(): Promise<InstalledPackage[]> {
    const args = ['-m', 'pip', 'list', '--format=json'];

    logger.info(`Running command: ${PATHS.PYTHON} ${args.join(' ')}`);
    logger.info(`Working directory: ${PATHS.VS}`);

    return new Promise((resolve) => {
      const checkProcess = spawn(PATHS.PYTHON, args, {
        cwd: PATHS.VS,
        windowsHide: true
      });

      let outputBuffer = '';
      let errorBuffer = '';

      checkProcess.stdout?.on('data', (data: Buffer) => {
        outputBuffer += data.toString();
      });

      checkProcess.stderr?.on('data', (data: Buffer) => {
        errorBuffer += data.toString();
      });

      checkProcess.on('close', (code: number | null) => {
        if (code === 0) {
          try {
            const parsed = JSON.parse(outputBuffer) as Array<{ name: string; version?: string }>;
            resolve(parsed.map(pkg => ({
              name: normalizePackageName(pkg.name),
              version: pkg.version ?? ''
            })));
          } catch (error) {
            logger.error('Error parsing pip list output:', error);
            logger.error('Output buffer:', outputBuffer);
            resolve([]);
          }
        } else {
          logger.error(`Failed to check installed packages (exit code: ${code})`);
          if (errorBuffer.trim()) {
            logger.error('Error output:', errorBuffer);
          }
          if (outputBuffer.trim()) {
            logger.error('Standard output:', outputBuffer);
          }
          resolve([]);
        }
      });

      checkProcess.on('error', (error: Error) => {
        logger.error('Failed to run pip list:', error);
        logger.error('Python path:', PATHS.PYTHON);
        logger.error('VS path:', PATHS.VS);
        resolve([]);
      });
    });
  }

  /**
   * Plain `pip uninstall -y` runner without progress reporting, used by the
   * vendor purge step (uninstallDependencies keeps its own progress-emitting
   * spawn).
   */
  private async runPipUninstall(packages: string[]): Promise<{ success: boolean; error?: string }> {
    const args = ['-m', 'pip', 'uninstall', '-y', ...packages];
    logger.info(`Running command: ${PATHS.PYTHON} ${args.join(' ')}`);

    return new Promise((resolve) => {
      this.installProcess = spawn(PATHS.PYTHON, args, createWorkloadSpawnOptions({
        cwd: PATHS.VS,
        windowsHide: true
      }));

      let errorBuffer = '';

      const processLine = (line: string) => {
        const trimmed = line.trim();
        if (trimmed) logger.info(`[pip] ${trimmed}`);
      };

      this.installProcess.stdout?.on('data', (data: Buffer) => {
        data.toString().split('\n').forEach(processLine);
      });

      this.installProcess.stderr?.on('data', (data: Buffer) => {
        const output = data.toString();
        errorBuffer += output;
        output.split('\n').forEach(processLine);
      });

      this.installProcess.on('close', (code: number | null) => {
        this.installProcess = null;
        if (code === 0) {
          resolve({ success: true });
        } else {
          resolve({ success: false, error: `pip uninstall failed with exit code ${code}: ${errorBuffer.trim()}` });
        }
      });

      this.installProcess.on('error', (error: Error) => {
        this.installProcess = null;
        resolve({ success: false, error: error.message });
      });
    });
  }

  async installDependencies(): Promise<{ success: boolean; error?: string }> {
    logger.info('Starting plugin dependency installation');
    this.isCancelled = false;

    try {
      // The vendor decides the torch flavor, the vsjetpack extras and which
      // inference backends get installed. Persist the detection immediately;
      // pluginsGpuVendor is only written once the install actually succeeds.
      const vendor = await detectGpuVendor();
      await configManager.setGpuVendor(vendor);
      logger.info(`Installing for GPU vendor: ${vendor}`);

      this.sendProgress({
        type: 'installing',
        progress: 0,
        message: `Preparing to install Python packages from PyPI (GPU vendor: ${vendor})...`
      });

      logger.info('Starting plugin dependency installation...');

      // Step 0: Ensure setuptools and wheel are installed (0-3% progress)
      logger.info('=== Step 0: Ensuring setuptools and wheel are installed ===');
      const setupResult = await this.runPipInstall(
        ['setuptools', 'wheel'],
        0,
        3,
        ['--upgrade']
      );

      if (!setupResult.success) {
        this.sendProgress({
          type: 'error',
          progress: 0,
          message: setupResult.error || 'Failed to install setuptools and wheel'
        });
        return { success: false, error: setupResult.error };
      }

      if (this.isCancelled) {
        return { success: false, error: 'Installation cancelled by user' };
      }

      // Step 0.5: remove packages belonging to a different GPU vendor, computed
      // fresh from pip list. Runs BEFORE the --upgrade install so pip re-resolves
      // anything that is actually still required. Non-fatal: a failure only costs
      // the torch flavor switch and some disk space.
      const purge = computeVendorPurge(vendor, await this.listInstalledPackages());
      if (purge.length > 0) {
        logger.info('=== Step 0.5: Removing packages from a different GPU configuration ===');
        logger.info(`Packages to remove: ${purge.join(', ')}`);
        this.sendProgress({
          type: 'installing',
          progress: 3,
          message: 'Removing packages from a different GPU configuration...'
        });
        const purgeResult = await this.runPipUninstall(purge);
        if (!purgeResult.success) {
          logger.warn(`Failed to remove mismatched packages (continuing anyway): ${purgeResult.error}`);
        }
      }

      if (this.isCancelled) {
        return { success: false, error: 'Installation cancelled by user' };
      }

      // Step 1: PyTorch (3-35% progress) — needed by the bundled (non-PyPI)
      // vs_deepdeinterlace scripts; everything else runs on TensorRT/ONNX Runtime.
      // CUDA wheels on NVIDIA, CPU wheels from the default PyPI index elsewhere.
      logger.info('=== Step 1: Installing PyTorch and torchvision ===');
      const torchInstall = getTorchInstall(vendor);
      const pytorchResult = await this.runPipInstall(
        torchInstall.packages,
        3,
        32,
        torchInstall.extraArgs
      );

      if (!pytorchResult.success) {
        this.sendProgress({
          type: 'error',
          progress: 0,
          message: pytorchResult.error || 'PyTorch installation failed'
        });
        return { success: false, error: pytorchResult.error };
      }

      if (this.isCancelled) {
        return { success: false, error: 'Installation cancelled by user' };
      }

      // Step 2: Extract bundled plugins without a PyPI counterpart (35-40% progress).
      // This runs BEFORE the pip install so that when a bundled DLL and a pip
      // wheel share a filename, the pip-managed (newer) copy wins.
      logger.info('=== Step 2: Extracting plugins from plugins folder ===');
      await this.extractAllPlugins();
      // The bundled archive still contains DLLs that PyPI wheels now provide —
      // remove those so the pip-managed versions are the only ones autoloaded.
      await removeSupersededPlugins();

      if (this.isCancelled) {
        return { success: false, error: 'Installation cancelled by user' };
      }

      // Step 3: VapourSynth ecosystem from PyPI (40-80% progress).
      // vsjetpack and the pifroggi packages pull all native plugins (akarin,
      // vszip, bestsource, vs-mlrt, zsmooth, ...) as dependencies — and on
      // NVIDIA, TensorRT itself through the vs-mlrt TRT wheel.
      logger.info('=== Step 3: Installing VapourSynth ecosystem from PyPI ===');
      const pypiPackages = [
        // Vendor-selected ecosystem (vsjetpack extras, torch-adjacent extras,
        // CUDA-only plugins) — see electron/vendorPackages.ts
        ...getPypiPackages(vendor),
        // Inference backend plugin wheels (vs-mlrt, pinned so the
        // stored-version engine rebuild check stays truthful). This is where
        // "which backends does this machine get" is decided at install time:
        // the vendor selects the backends, each backend declares its own
        // packages in electron/providers/
        ...getBackendPipPackages(vendor),
      ];
      const pypiResult = await this.runPipInstall(
        pypiPackages,
        40,
        40,
        ['--upgrade', ...PYPI_EXTRA_INDEX_ARGS]
      );

      if (!pypiResult.success) {
        this.sendProgress({
          type: 'error',
          progress: 0,
          message: pypiResult.error || 'PyPI packages installation failed'
        });
        return { success: false, error: pypiResult.error };
      }

      // Remove plugin builds that crash VapourSynth autoload and resolve the
      // ort/ort-cuda duplicate in favor of the build this vendor can use
      await applyPluginCompatibilityFixes(vendor);

      if (this.isCancelled) {
        return { success: false, error: 'Installation cancelled by user' };
      }

      // Step 4: Download and extract VapourSynth scripts from GitHub (85-90% progress)
      logger.info('=== Step 4: Downloading VapourSynth scripts from GitHub ===');
      await this.downloadAndExtractVSScripts();

      if (this.isCancelled) {
        return { success: false, error: 'Installation cancelled by user' };
      }

      // Step 4.5: vs-mlrt model zoo for the bundled RIFE/DPIR templates (the
      // pip wheels ship no models folder). Non-fatal: a download failure only
      // affects those templates, and startup re-attempts it (checkDependencies).
      if (await VsMlrtModelsManager.needsDownload()) {
        logger.info('=== Step 4.5: Downloading vs-mlrt model zoo (RIFE/DPIR) ===');
        try {
          await VsMlrtModelsManager.ensureModels((message) => {
            this.sendProgress({ type: 'installing', progress: 90, message });
          });
        } catch (error) {
          logger.warn('vs-mlrt model zoo download failed (continuing; retried at next startup):', error);
        }
      }

      // Step 4.6: trtexec shim so vsmlrt's script-side TensorRT backend can
      // build engines at runtime (pip TensorRT ships no trtexec binary).
      // Non-fatal, and re-attempted at every startup by checkDependencies.
      try {
        await ensureTrtexecShim();
      } catch (error) {
        logger.warn('Failed to write the trtexec shim (continuing; retried at next startup):', error);
      }

      if (this.isCancelled) {
        return { success: false, error: 'Installation cancelled by user' };
      }

      // Step 5: Extract all scripts from scripts folder (90-95% progress)
      logger.info('=== Step 5: Extracting scripts from scripts folder ===');
      await this.extractAllScripts();
      // Same for script modules that are now pip-installed (vs_temporalfix, ...)
      await removeSupersededScripts();

      if (this.isCancelled) {
        return { success: false, error: 'Installation cancelled by user' };
      }

      // Step 6: Copy filter templates (95-100% progress)
      logger.info('=== Step 6: Copying filter templates ===');
      await this.copyFilterTemplates();

      // Step 7: Reload backend to refresh models and configs
      logger.info('=== Step 7: Reloading backend ===');
      try {
        await configManager.load();
        logger.info('Backend reloaded successfully');
        
        // Notify frontend to refresh models
        if (this.mainWindow) {
          this.mainWindow.webContents.send('backend-reloaded');
        }
      } catch (error) {
        logger.error('Failed to reload backend:', error);
        // Don't fail the entire installation if backend reload fails
      }

      // Record the vendor the installed set targets only after a fully
      // successful install, so a failed AMD run can't mask a working NVIDIA one.
      await configManager.setPluginsGpuVendor(vendor);

      // All installations complete
      logger.info('All plugin dependencies and plugins installed successfully');
      logger.info('='.repeat(50));
      logger.info('✓ All dependencies installed successfully!');
      logger.info('='.repeat(50));
      this.sendProgress({
        type: 'complete',
        progress: 100,
        message: 'Dependencies installed successfully!'
      });
      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Plugin dependency installation error:', errorMsg);
      this.sendProgress({
        type: 'error',
        progress: 0,
        message: errorMsg
      });
      return { success: false, error: errorMsg };
    }
  }

  async installDependenciesForSetup(): Promise<{ success: boolean; error?: string }> {
    this.useSetupChannel = true;
    try {
      logger.info('Starting plugin dependency installation (setup mode, attempt 1/2)');
      const firstResult = await this.installDependencies();
      if (firstResult.success) {
        return firstResult;
      }

      if (this.isCancelled) {
        return firstResult;
      }

      logger.info(`Plugin install attempt 1 failed (${firstResult.error}); retrying once`);
      this.isCancelled = false;
      const secondResult = await this.installDependencies();
      if (!secondResult.success) {
        logger.error(`Plugin install retry failed: ${secondResult.error}`);
      }
      return secondResult;
    } finally {
      this.useSetupChannel = false;
    }
  }

  async checkInstalled(): Promise<{ installed: boolean; packages: string[] }> {
    logger.info('Checking if plugin dependencies are installed');

    // The persisted vendor is refreshed at every app mount by the
    // detect-cuda-support handler, so the probe is a cold-start fallback only.
    const vendor = configManager.getGpuVendor() ?? await detectGpuVendor();

    // Normalized (PEP 503) names — compared against pip list output with
    // underscores mapped to dashes.
    const packagesToCheck = getCheckPackageNames(vendor);
    const installedNames = new Set((await this.listInstalledPackages()).map(pkg => pkg.name));

    const foundPackages = packagesToCheck.filter(name => installedNames.has(name));
    const missingNames = packagesToCheck.filter(name => !installedNames.has(name));

    const state = evaluateInstallState(vendor, configManager.getPluginsGpuVendor(), missingNames);

    if (state.backfillVendor) {
      // Pre-vendor-tracking install on NVIDIA: every 0.17.0 install was
      // CUDA-flavored, so grandfather it in instead of forcing a reinstall.
      await configManager.setPluginsGpuVendor(state.backfillVendor);
      logger.info(`Recorded existing plugin install as GPU vendor '${state.backfillVendor}'`);
    }

    logger.info(
      `Dependencies check (GPU vendor: ${vendor}): ${state.installed ? 'installed' : 'not installed'} ` +
      `[${state.reason}] (${foundPackages.length}/${packagesToCheck.length} packages present)`
    );
    if (missingNames.length > 0) {
      logger.info(`Missing packages: ${missingNames.join(', ')}`);
    }

    return { installed: state.installed, packages: foundPackages };
  }

  async uninstallDependencies(): Promise<{ success: boolean; error?: string }> {
    logger.info('Starting plugin dependency uninstallation');
    this.isCancelled = false;

    try {
      this.sendProgress({
        type: 'installing',
        progress: 0,
        message: 'Preparing to uninstall dependencies...'
      });

      // Shared, deliberately vendor-neutral list — see the comment on
      // UNINSTALL_PACKAGE_NAMES in vendorPackages.ts for why this must NOT
      // branch on the GPU vendor.
      const packagesToUninstall = UNINSTALL_PACKAGE_NAMES;
      const args = ['-m', 'pip', 'uninstall', '-y', ...packagesToUninstall];
      
      const commandStr = `${PATHS.PYTHON} ${args.join(' ')}`;
      logger.info(`Running command: ${commandStr}`);

      return new Promise((resolve) => {
        this.installProcess = spawn(PATHS.PYTHON, args, createWorkloadSpawnOptions({
          cwd: PATHS.VS,
          windowsHide: true
        }));

        let errorBuffer = '';
        let progress = 0;
        let lineBuffer = '';

        const processLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;

          logger.info(`[pip] ${trimmed}`);

          if (trimmed.includes('Uninstalling')) {
            const pkgMatch = trimmed.match(/Uninstalling\s+([^\s-]+)/);
            if (pkgMatch) {
              progress += 15;
              this.sendProgress({
                type: 'installing',
                progress: Math.min(progress, 95),
                message: `Uninstalling ${pkgMatch[1]}...`
              });
            }
          } else if (trimmed.includes('Successfully uninstalled')) {
            const pkgMatch = trimmed.match(/Successfully uninstalled\s+([^\s-]+)/);
            if (pkgMatch) {
              this.sendProgress({
                type: 'installing',
                progress: Math.min(progress, 95),
                message: `Uninstalled ${pkgMatch[1]}`
              });
            }
          }
        };

        this.installProcess.stdout?.on('data', (data: Buffer) => {
          const output = data.toString();
          lineBuffer += output;
          
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop() || '';
          
          lines.forEach(line => processLine(line));
        });

        this.installProcess.stderr?.on('data', (data: Buffer) => {
          const output = data.toString();
          errorBuffer += output;
          
          const lines = output.split('\n');
          lines.forEach(line => processLine(line));
        });

        this.installProcess.on('close', (code: number | null) => {
          if (lineBuffer.trim()) {
            processLine(lineBuffer);
          }
          
          this.installProcess = null;

          if (this.isCancelled) {
            logger.info('Plugin dependency uninstallation cancelled');
            resolve({ success: false, error: 'Uninstallation cancelled by user' });
            return;
          }

          if (code === 0) {
            logger.info('Dependencies uninstalled successfully');
            this.sendProgress({
              type: 'complete',
              progress: 100,
              message: 'Dependencies uninstalled successfully!'
            });
            resolve({ success: true });
          } else {
            const errorMsg = `Uninstallation failed with exit code ${code}`;
            logger.error(errorMsg);
            if (errorBuffer.trim()) {
              logger.error('Error output:');
              errorBuffer.split('\n').forEach(line => {
                if (line.trim()) logger.error(`  ${line}`);
              });
            }
            this.sendProgress({
              type: 'error',
              progress: 0,
              message: errorMsg
            });
            resolve({ success: false, error: errorMsg });
          }
        });

        this.installProcess.on('error', (error: Error) => {
          logger.error('Failed to start pip uninstall process:', error);
          this.sendProgress({
            type: 'error',
            progress: 0,
            message: error.message
          });
          resolve({ success: false, error: error.message });
        });
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Plugin dependency uninstallation error:', errorMsg);
      this.sendProgress({
        type: 'error',
        progress: 0,
        message: errorMsg
      });
      return { success: false, error: errorMsg };
    }
  }

  emitSetupComplete(): void {
    if (this.mainWindow) {
      this.mainWindow.webContents.send('setup-progress', {
        type: 'complete',
        component: 'All Dependencies',
        progress: 100,
        message: 'All dependencies and plugins installed successfully!',
      });
    }
  }

  cancel(): void {
    if (this.installProcess) {
      logger.info('Cancelling plugin dependency operation');
      this.isCancelled = true;
      terminateProcessTree(this.installProcess, 'SIGTERM');
      this.installProcess = null;
    }
  }

  private async extractAllPlugins(): Promise<void> {
    if (!shouldExtractBundledPluginArchives()) {
      // include/plugins/*.7z is a legacy Windows bundle of native DLLs. Linux
      // must use the platform-specific wheels installed in the PyPI phase.
      logger.info('Bundled native plugin archives are Windows-only; skipping plugin extraction');
      return;
    }

    logger.info('Extracting all plugins from plugins folder');
    
    // Get bundled plugins path
    const bundledBasePath = getBundledBasePath();
    const pluginsFolder = path.join(bundledBasePath, 'include', 'plugins');
    
    if (!await fs.pathExists(pluginsFolder)) {
      logger.info('No plugins folder found, skipping plugin extraction');
      return;
    }

    this.sendProgress({
      type: 'installing',
      progress: 35,
      message: 'Extracting plugins...'
    });

    // Get all .7z files in the plugins folder
    const files = await fs.readdir(pluginsFolder);
    const archiveFiles = files.filter(f => f.endsWith('.7z'));
    
    if (archiveFiles.length === 0) {
      logger.info('No plugin archives found in plugins folder');
      return;
    }

    logger.info(`Found ${archiveFiles.length} plugin archive(s) to extract`);
    
    for (let i = 0; i < archiveFiles.length; i++) {
      const archiveFile = archiveFiles[i];
      const archivePath = path.join(pluginsFolder, archiveFile);
      const progress = 35 + Math.floor((i / archiveFiles.length) * 5);
      
      logger.info(`Extracting ${archiveFile} (${i + 1}/${archiveFiles.length})`);
      
      this.sendProgress({
        type: 'installing',
        progress,
        message: `Extracting ${archiveFile}...`
      });

      try {
        // Skip-existing: the plugins folder is shared with pip-installed wheels,
        // and several bundled DLLs share filenames with pip-managed ones — the
        // bundle must never overwrite them. (On fresh installs pip runs after
        // this and overwrites same-named bundled copies, so pip always wins.)
        await this.extractArchive(archivePath, PATHS.PLUGINS, archiveFile, { skipExisting: true });
        logger.info(`Successfully extracted ${archiveFile}`);
      } catch (error) {
        logger.error(`Failed to extract ${archiveFile}:`, error);
        // Continue with other plugins even if one fails
      }
    }

    logger.info('Plugin extraction completed');
  }

  private async downloadAndExtractVSScripts(): Promise<void> {
    const downloadUrl = 'https://github.com/Selur/VapoursynthScriptsInHybrid/archive/d430e1973a78c2dc52a6e4aa58e5f89cc0093ae9.zip';
    const tempDir = path.join(PATHS.APP_DATA, 'temp');
    const zipPath = path.join(tempDir, 'vs-scripts.zip');
    const extractPath = path.join(tempDir, 'vs-scripts-extracted');

    logger.info('Downloading VapourSynth scripts from GitHub');
    this.sendProgress({
      type: 'installing',
      progress: 85,
      message: 'Downloading VapourSynth scripts...'
    });

    try {
      // Ensure temp directory exists
      await fs.ensureDir(tempDir);

      // Download the zip file
      await new Promise<void>((resolve, reject) => {
        const file = fs.createWriteStream(zipPath);
        https.get(downloadUrl, (response) => {
          if (response.statusCode === 302 || response.statusCode === 301) {
            // Handle redirect
            const redirectUrl = response.headers.location;
            if (redirectUrl) {
              https.get(redirectUrl, (redirectResponse) => {
                redirectResponse.pipe(file);
                file.on('finish', () => {
                  file.close();
                  resolve();
                });
              }).on('error', (err) => {
                fs.unlink(zipPath, () => {});
                reject(err);
              });
            } else {
              reject(new Error('Redirect without location'));
            }
          } else {
            response.pipe(file);
            file.on('finish', () => {
              file.close();
              resolve();
            });
          }
        }).on('error', (err) => {
          fs.unlink(zipPath, () => {});
          reject(err);
        });

        file.on('error', (err) => {
          fs.unlink(zipPath, () => {});
          reject(err);
        });
      });

      logger.info('Download completed, extracting...');
      this.sendProgress({
        type: 'installing',
        progress: 87,
        message: 'Extracting VapourSynth scripts...'
      });

      // Extract the zip file
      await fs.ensureDir(extractPath);
      await _7z.unpack(zipPath, extractPath);

      // Find all .py files in the extracted directory and move them to PATHS.SCRIPTS
      logger.info('Moving .py files to vs-scripts folder');
      await fs.ensureDir(PATHS.SCRIPTS);

      const findPyFiles = async (dir: string): Promise<string[]> => {
        const pyFiles: string[] = [];
        const entries = await fs.readdir(dir, { withFileTypes: true });
        
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            pyFiles.push(...await findPyFiles(fullPath));
          } else if (entry.isFile() && entry.name.endsWith('.py')) {
            pyFiles.push(fullPath);
          }
        }
        
        return pyFiles;
      };

      const pyFiles = await findPyFiles(extractPath);
      logger.info(`Found ${pyFiles.length} .py file(s)`);

      for (const pyFile of pyFiles) {
        const fileName = path.basename(pyFile);
        const destPath = path.join(PATHS.SCRIPTS, fileName);
        await fs.copy(pyFile, destPath, { overwrite: true });
        logger.info(`Copied ${fileName} to vs-scripts folder`);
      }

      // Clean up temp files
      await fs.remove(zipPath);
      await fs.remove(extractPath);
      logger.info('VapourSynth scripts download and extraction completed');

    } catch (error) {
      logger.error('Failed to download and extract VapourSynth scripts:', error);
      // Clean up on error
      try {
        await fs.remove(zipPath);
        await fs.remove(extractPath);
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  private async extractAllScripts(): Promise<void> {
    logger.info('Extracting all scripts from scripts folder');
    
    // Get bundled scripts path
    const bundledBasePath = getBundledBasePath();
    const scriptsFolder = path.join(bundledBasePath, 'include', 'scripts');
    
    if (!await fs.pathExists(scriptsFolder)) {
      logger.info('No scripts folder found, skipping script extraction');
      return;
    }

    this.sendProgress({
      type: 'installing',
      progress: 90,
      message: 'Extracting scripts...'
    });

    // Get all .7z files in the scripts folder
    const files = await fs.readdir(scriptsFolder);
    const archiveFiles = files.filter(f => f.endsWith('.7z'));
    
    if (archiveFiles.length === 0) {
      logger.info('No script archives found in scripts folder');
      return;
    }

    logger.info(`Found ${archiveFiles.length} script archive(s) to extract`);
    
    for (let i = 0; i < archiveFiles.length; i++) {
      const archiveFile = archiveFiles[i];
      const archivePath = path.join(scriptsFolder, archiveFile);
      const progress = 90 + Math.floor((i / archiveFiles.length) * 5);
      
      logger.info(`Extracting ${archiveFile} (${i + 1}/${archiveFiles.length})`);
      
      this.sendProgress({
        type: 'installing',
        progress,
        message: `Extracting ${archiveFile}...`
      });

      try {
        await this.extractArchive(archivePath, PATHS.SCRIPTS, archiveFile);
        logger.info(`Successfully extracted ${archiveFile}`);
      } catch (error) {
        logger.error(`Failed to extract ${archiveFile}:`, error);
        // Continue with other scripts even if one fails
      }
    }
    
    logger.info('Script extraction completed');
  }

  private async extractArchive(
    archivePath: string,
    outputPath: string,
    componentName: string,
    options: { skipExisting?: boolean } = {}
  ): Promise<void> {
    logger.info(`Extracting ${componentName} from ${archivePath} to ${outputPath}${options.skipExisting ? ' (skip existing)' : ''}`);
    await fs.ensureDir(outputPath);

    const maxRetries = 5;
    const retryDelay = 2000; // 2 seconds
    let lastError: any = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (options.skipExisting) {
          // -aos = skip files that already exist in the destination
          await _7z.cmd(['x', archivePath, `-o${outputPath}`, '-aos', '-y']);
        } else {
          await _7z.unpack(archivePath, outputPath);
        }
        logger.info(`Extraction completed: ${componentName}`);
        return; // Success, exit the function
      } catch (err: any) {
        lastError = err;
        const errorMessage = err.message || String(err);
        
        // Check if it's a file locking error
        const isFileLockError = 
          errorMessage.includes('Can not open the file as archive') ||
          errorMessage.includes('The process cannot access the file because it is being used by another process') ||
          errorMessage.includes("Can't open as archive");
        
        if (isFileLockError && attempt < maxRetries) {
          logger.info(`File locked during extraction (attempt ${attempt}/${maxRetries}), retrying in ${retryDelay}ms...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          continue;
        }
        
        // If it's not a file lock error, or we've exhausted retries, throw
        const errorMsg = `Error extracting ${componentName}: ${errorMessage}`;
        logger.error(errorMsg);
        if (attempt === maxRetries) {
          logger.error(`Failed after ${maxRetries} attempts`);
        }
        throw err;
      }
    }

    // Should never reach here, but just in case
    throw lastError;
  }

  private async copyFilterTemplates(): Promise<void> {
    if (!shouldCopyBundledPluginFilterTemplates()) {
      // The plugin_filters catalog contains templates for DLL/CUDA dependencies
      // bundled only on Windows. Linux starts with the shared catalog and can
      // later add explicitly Linux-compatible templates.
      logger.info('Bundled plugin filter templates are Windows-only; skipping copy');
      return;
    }

    logger.info('Copying filter templates from plugin_filters folder');
    
    // Get bundled plugin_filters path
    const bundledBasePath = getBundledBasePath();
    const pluginFiltersFolder = path.join(bundledBasePath, 'include', 'plugins', 'plugin_filters');
    
    if (!await fs.pathExists(pluginFiltersFolder)) {
      logger.info('No plugin_filters folder found, skipping filter template copy');
      return;
    }

    this.sendProgress({
      type: 'installing',
      progress: 95,
      message: 'Copying filter templates...'
    });

    // Ensure the filter templates directory exists
    await fs.ensureDir(PATHS.FILTER_TEMPLATES);

    // Get all files in the plugin_filters folder
    const files = await fs.readdir(pluginFiltersFolder);
    
    if (files.length === 0) {
      logger.info('No filter templates found in plugin_filters folder');
      return;
    }

    logger.info(`Found ${files.length} filter template(s) to copy`);
    
    for (const file of files) {
      const sourcePath = path.join(pluginFiltersFolder, file);
      const destPath = path.join(PATHS.FILTER_TEMPLATES, file);
      
      // Check if it's a file (not a directory)
      const stats = await fs.stat(sourcePath);
      if (stats.isFile()) {
        try {
          await fs.copy(sourcePath, destPath, { overwrite: true });
          logger.info(`Copied filter template: ${file}`);
        } catch (error) {
          logger.error(`Failed to copy filter template ${file}:`, error);
          // Continue with other templates even if one fails
        }
      }
    }
    
    logger.info('Filter template copy completed');
  }
}
