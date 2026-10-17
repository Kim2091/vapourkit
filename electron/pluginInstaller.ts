// electron/pluginInstaller.ts
import { BrowserWindow } from 'electron';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';
import { logger } from './logger';
import { PATHS, PYPI_EXTRA_INDEX_ARGS } from './constants';
import { configManager } from './configManager';
import { getBundledBasePath } from './utils';
import { canImportModules, pipInstall, pipList, pipUninstall, PipLockAbortedError, withPipLock, type ImportCheck } from './pip';
import { shouldExtractBundledPluginArchives } from './bundledPluginArchives';
import { installPluginTemplates } from './templateInstaller';
import { removeSupersededPlugins, removeSupersededScripts, applyPluginCompatibilityFixes } from './legacyCleanup';
import { VsMlrtModelsManager } from './vsMlrtModelsManager';
import { MigxRuntimeManager } from './migxRuntimeManager';
import { ensureTrtexecShim } from './trtexecShim';
import { syncInstalledScripts } from './scriptSync';
import { detectGpuVendor, type GpuVendor } from './gpuDetection';
import { classifyInstallError } from './installErrors';
import {
  PLUGIN_INSTALL_REQUIRED_BYTES,
  PLUGIN_INSTALL_REQUIRED_TEMP_BYTES,
  prunePipCache,
  runInstallPreflight,
} from './installPreflight';
import {
  archiveFileNames,
  describeInstallFailure,
  describeVanishedFiles,
  failureResult,
  isRetryableFailure,
  judgePreflight,
  runWithRetry,
  SingleFlight,
  type InstallResult,
} from './installFlow';
import {
  brokenProjectNames,
  inspectPythonEnvironment,
  repairPythonEnvironment,
} from './pythonEnvIntegrity';
import {
  computeVendorPurge,
  evaluateInstallState,
  getBackendPipPackages,
  getBackendsForVendor,
  getCheckPackageNames,
  getPypiPackages,
  getTorchInstall,
  getNoDepsPackages,
  normalizePackageName,
  UNINSTALL_PACKAGE_NAMES,
  type InstalledPackage,
} from './vendorPackages';
import * as _7z from '7zip-min';
import { extract7z } from './archive';

/** A reinstall that keeps what the user changed, or one that restores everything shipped. */
export type InstallMode = 'partial' | 'complete';

/**
 * 'retrying' is an attempt that failed with another about to start, and
 * 'warning' something to tell the user that does not stop the install; only
 * 'complete' and 'error' end one.
 */
export interface PluginDependencyProgress {
  type: 'installing' | 'retrying' | 'warning' | 'complete' | 'error';
  progress: number;
  message: string;
  summary?: string;
  evidence?: string;
  logPath?: string;
  warnings?: string[];
}

interface SetupProgressEvent extends PluginDependencyProgress {
  component: string;
}

/**
 * pip's cache only saves downloads, and an NVIDIA install puts ~5 GB in it
 * (a 1.8 GB torch wheel alone). It earns its space within one install - the
 * torch repair step and setup's second attempt reuse what the first fetched -
 * so it is left alone while an install runs and cut back once one succeeds.
 * prunePipCache removes the whole cache above this size, so after a full
 * install it is usually emptied, and a later reinstall downloads again.
 */
const PIP_CACHE_LIMIT_BYTES = 1024 ** 3;

const CANCELLED: InstallResult = { success: false, cancelled: true, error: 'Installation cancelled by user' };

/**
 * Turns the stderr of a failed `import torch, torchgen` into the dialog text.
 *
 * Users often don't send logs, so the Python error goes in the details itself,
 * and the likely cause is named from it. A DLL that won't load is usually a
 * missing or old Visual C++ runtime, not a deleted file, so antivirus is only
 * named first when a module or file is actually missing.
 */
export function describeTorchImportFailure(stderr: string): { summary: string; evidence: string } {
  const lines = stderr.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  const evidence = (last || 'import torch, torchgen failed with no error output').slice(0, 400);
  const prefix = 'Repairing PyTorch failed: it still cannot be imported after reinstalling. ';

  if (/WinError (126|127|1114)|DLL load failed|Error loading ".*\.dll"/i.test(stderr)) {
    return {
      summary: prefix + 'One of its DLLs will not load, which usually means the Microsoft Visual C++ ' +
        'Redistributable (x64) is missing or outdated. Install the latest one from Microsoft and retry. ' +
        'If it is already current, antivirus may be blocking the DLL.',
      evidence,
    };
  }
  if (/ModuleNotFoundError|No module named|FileNotFoundError|No such file/i.test(stderr)) {
    return {
      summary: prefix + 'Some of its files are missing, which usually means antivirus removed them. ' +
        'Allow Vapourkit\'s folder in your antivirus and retry.',
      evidence,
    };
  }
  return {
    summary: prefix + 'The details show the Python error.',
    evidence,
  };
}

export class PluginInstaller {
  private mainWindow: BrowserWindow | null;
  private isCancelled: boolean = false;
  private useSetupChannel: boolean = false;
  // A second request for the running operation joins it, and a different one
  // is refused; the pip lock keeps other writers out of site-packages.
  private flights = new SingleFlight<'install' | 'uninstall', InstallResult>();
  private abortController: AbortController | null = null;
  private warnings: string[] = [];

  constructor(mainWindow: BrowserWindow | null = null) {
    this.mainWindow = mainWindow;
  }

  private sendProgress(progress: PluginDependencyProgress) {
    if (!this.mainWindow) return;
    if (this.useSetupChannel) {
      const setupEvent: SetupProgressEvent = { ...progress, component: 'Plugins' };
      this.mainWindow.webContents.send('setup-progress', setupEvent);
    } else {
      this.mainWindow.webContents.send('plugin-dependency-progress', progress);
    }
  }

  /** Logged, shown as it happens, and carried on the result so the UI can keep it on screen. */
  private warn(message: string, progress: number) {
    logger.warn(message);
    this.warnings.push(message);
    this.sendProgress({ type: 'warning', progress, message });
  }

  /** The one terminal error event for an operation, sent after its last attempt. */
  private emitFailure(result: InstallResult) {
    if (result.success || result.cancelled) return;
    this.sendProgress({
      type: 'error',
      progress: 0,
      message: result.error ?? result.summary ?? 'Installation failed',
      summary: result.summary,
      evidence: result.evidence,
      logPath: result.logPath,
      warnings: this.warnings.length > 0 ? [...this.warnings] : undefined,
    });
  }

  private busyResult(running: 'install' | 'uninstall'): InstallResult {
    const what = running === 'install' ? 'A plugin install' : 'A plugin uninstall';
    const error = `${what} is already running. Wait for it to finish (or cancel it), then try again.`;
    logger.warn(`Refused a plugin operation: ${what.toLowerCase()} is already running`);
    return { success: false, alreadyRunning: true, error, summary: error };
  }

  /** Fresh cancel state for one operation, however many attempts it makes. */
  private beginOperation() {
    this.isCancelled = false;
    this.abortController = new AbortController();
    this.warnings = [];
  }

  /**
   * Runs one whole operation with the Python environment to itself, so no
   * other pip (a launch repair, a vs-mlrt update) runs between its steps. A
   * cancel while it waits for the environment ends it as cancelled.
   */
  private async withEnvironment(label: string, run: () => Promise<InstallResult>): Promise<InstallResult> {
    try {
      return await withPipLock(run, {
        label,
        signal: this.abortController?.signal,
        onWait: heldBy => this.sendProgress({
          type: 'installing',
          progress: 0,
          message: `Waiting for another Python package operation (${heldBy}) to finish...`,
        }),
      });
    } catch (error) {
      if (error instanceof PipLockAbortedError) return CANCELLED;
      throw error;
    }
  }

  private withWarnings(result: InstallResult): InstallResult {
    return this.warnings.length > 0 ? { ...result, warnings: [...this.warnings] } : result;
  }

  /**
   * `step` names what this run is for ("Installing PyTorch"); it opens the
   * sentence the user sees if pip fails.
   */
  private async runPipInstall(
    step: string,
    packages: string[],
    progressOffset: number,
    progressScale: number,
    extraArgs: string[] = []
  ): Promise<InstallResult> {
    // A cancel that landed between two steps must not start the next pip.
    if (this.isCancelled) {
      return CANCELLED;
    }

    let lastProgress = 0;
    let currentPackage = '';
    const sendUpdate = (message: string, progressBoost: number = 0) => {
      lastProgress = Math.max(lastProgress, progressBoost);
      const scaledProgress = progressOffset + (lastProgress * progressScale / 100);
      this.sendProgress({
        type: 'installing',
        progress: Math.min(scaledProgress, 99),
        message
      });
    };

    const processLine = (trimmed: string) => {
      let packageMatch = trimmed.match(/Collecting\s+([^\s(]+)/);
      if (packageMatch) {
        currentPackage = packageMatch[1];
        sendUpdate(`Collecting ${currentPackage}...`, 10);
        return;
      }

      packageMatch = trimmed.match(/Downloading\s+([^\s(]+)/);
      if (packageMatch) {
        currentPackage = packageMatch[1];
        sendUpdate(`Downloading ${currentPackage}...`, 30);
        return;
      }

      const packagesMatch = trimmed.match(/Installing collected packages:\s*(.+)/);
      if (packagesMatch) {
        sendUpdate(`Installing packages: ${packagesMatch[1]}`, 80);
        return;
      }

      const installedMatch = trimmed.match(/Successfully installed\s+(.+)/);
      if (installedMatch) {
        sendUpdate(`Successfully installed: ${installedMatch[1]}`, 95);
        return;
      }

      const reqMatch = trimmed.match(/Requirement already satisfied:\s+([^\s]+)/);
      if (reqMatch) {
        sendUpdate(`${reqMatch[1]} already installed`, lastProgress);
        return;
      }

      const cachedMatch = trimmed.match(/Using cached\s+([^\s(]+)/);
      if (cachedMatch) {
        sendUpdate(`Using cached ${cachedMatch[1]}`, lastProgress);
        return;
      }

      if (trimmed.includes('Building wheel') || trimmed.includes('Preparing metadata')) {
        sendUpdate(currentPackage ? `Building ${currentPackage}...` : 'Building packages...', 60);
      }
    };

    const outcome = await pipInstall(packages, {
      step,
      extraArgs,
      shortPrefix: true,
      onLine: processLine,
      signal: this.abortController?.signal,
    });
    if (outcome.cancelled || this.isCancelled) {
      logger.info('Plugin dependency installation cancelled');
      return CANCELLED;
    }
    if (outcome.ok) {
      logger.info(`✓ ${step} completed successfully`);
      return { success: true };
    }
    return failureResult(outcome.failure!, logger.getLogPath());
  }

  /**
   * Clears anything in site-packages that would make the install below fail or
   * silently do nothing, and reports what it found.
   *
   * pip aborts an entire invocation when a single installed distribution
   * cannot be read — it will not replace files it has no RECORD for — so one
   * interrupted install blocks every later one until the rubble is cleared.
   * Non-fatal by design: if a directory cannot be deleted, the install still
   * runs and pip gets to produce the real error.
   */
  private async repairEnvironmentIntegrity(): Promise<void> {
    const report = await inspectPythonEnvironment(PATHS.SITE_PACKAGES);
    if (report.problems.length === 0 && report.staleDirectories.length === 0) {
      return;
    }

    for (const problem of report.problems) {
      logger.warn(`Damaged package ${problem.project}: ${problem.detail} (${problem.directory})`);
    }
    for (const directory of report.staleDirectories) {
      logger.warn(`Leftover directory from an interrupted uninstall: ${directory}`);
    }

    this.sendProgress({
      type: 'installing',
      progress: 0,
      message: 'Clearing a previously interrupted install...'
    });

    const { removed, failed } = await repairPythonEnvironment(PATHS.SITE_PACKAGES, report);
    logger.info(`Cleared ${removed.length} damaged package director${removed.length === 1 ? 'y' : 'ies'} before installing`);
    for (const failure of failed) {
      logger.warn(`Could not clear ${failure.directory}; pip may fail on it: ${failure.error}`);
    }
  }

  private checkTorchRuntime(): Promise<ImportCheck> {
    // torchgen is part of the official torch wheel, not the unrelated PyPI
    // distribution with the same name. Import both so a partial extraction is
    // caught even when pip still reports `torch` as installed.
    return canImportModules(['torch', 'torchgen'], 'PyTorch runtime');
  }

  /**
   * Reads the installed distributions from `pip list`, with names normalized
   * (PEP 503) once. Shared by the vendor purge and checkInstalled; an
   * unreadable environment resolves to an empty list, which reads as
   * "nothing installed" (matching the previous checkInstalled failure path).
   */
  private async listInstalledPackages(): Promise<InstalledPackage[]> {
    const listed = await pipList();
    return (listed ?? []).map(pkg => ({ name: normalizePackageName(pkg.name), version: pkg.version }));
  }

  /** `pip uninstall -y` without progress reporting, for the steps inside an install. */
  private async runPipUninstall(packages: string[]): Promise<{ success: boolean; error?: string }> {
    const outcome = await pipUninstall(packages, {
      step: 'Removing plugin packages',
      shortPrefix: true,
      signal: this.abortController?.signal,
    });
    return outcome.ok
      ? { success: true }
      : { success: false, error: outcome.cancelled ? 'cancelled' : `pip uninstall failed with exit code ${outcome.exitCode}: ${outcome.stderr.trim() || outcome.output.trim()}` };
  }

  /**
   * Installs the plugin package set, or joins the install already running.
   * A failure is reported to the renderer once, when it is final.
   */
  async installDependencies(mode: InstallMode = 'partial'): Promise<InstallResult> {
    return this.flights.run('install', async () => {
      this.beginOperation();
      const result = await this.withEnvironment('plugin install', () => this.runInstallAttempt(mode));
      this.emitFailure(result);
      return this.withWarnings(result);
    }, running => this.busyResult(running));
  }

  /**
   * The setup screen's plugin phase, with one automatic retry: a first
   * install on a fresh machine fails on transient things (a dropped
   * connection, antivirus holding a DLL while it scans it) that a second
   * attempt usually gets past, and the second attempt reuses what the first
   * downloaded because the pip cache is only pruned after a success.
   *
   * Nothing tells the renderer the install failed until the retry has too.
   * The setup screen offers Retry and "Continue without plugins" on that
   * event, and offering them while attempt 2 was still running is how a
   * second pip came to be started into the same environment.
   */
  async installDependenciesForSetup(): Promise<InstallResult> {
    return this.flights.run('install', async () => {
      this.beginOperation();
      this.useSetupChannel = true;
      try {
        const result = await this.withEnvironment('plugin install', () => runWithRetry(
          async attempt => {
            logger.info(`Starting plugin dependency installation (setup mode, attempt ${attempt}/2)`);
            return this.runInstallAttempt();
          },
          {
            attempts: 2,
            shouldRetry: failed => isRetryableFailure(failed) && !this.isCancelled,
            onRetry: (failed, next) => {
              logger.info(`Plugin install attempt ${next - 1} failed (${failed.summary ?? failed.error}); retrying once`);
              this.sendProgress({
                type: 'retrying',
                progress: 0,
                message: `${failed.summary ?? 'The plugin install failed.'} Retrying automatically (attempt ${next} of 2)...`,
              });
            },
          },
        ));
        if (!result.success && !result.cancelled) {
          logger.error(`Plugin install failed after its automatic retry: ${result.summary ?? result.error}`);
        }
        this.emitFailure(result);
        return this.withWarnings(result);
      } finally {
        this.useSetupChannel = false;
      }
    }, running => this.busyResult(running));
  }

  /**
   * Refuses an install that cannot fit before any of it is downloaded, and
   * passes on what is only worth knowing. Returns the refusal, or null to go on.
   */
  private async preflight(vendor: GpuVendor): Promise<InstallResult | null> {
    let problems;
    try {
      problems = await runInstallPreflight({
        dataDir: PATHS.APP_DATA,
        tempDir: os.tmpdir(),
        requiredBytes: PLUGIN_INSTALL_REQUIRED_BYTES[vendor],
        requiredTempBytes: PLUGIN_INSTALL_REQUIRED_TEMP_BYTES[vendor],
      });
    } catch (error) {
      // The checks are there to save a doomed install, not to stop a
      // working one because a check itself broke.
      logger.warn('Install preflight could not run; installing anyway:', error);
      return null;
    }

    const verdict = judgePreflight(problems, {
      reinstall: configManager.getPluginsGpuVendor() === vendor,
      action: 'The plugin install',
    });
    for (const warning of verdict.warnings) {
      this.warn(warning.message, 0);
    }
    if (!verdict.refusal) {
      return null;
    }
    logger.error(`Plugin install refused by preflight: ${verdict.refusal}`);
    return { ...failureResult({ summary: verdict.refusal, evidence: verdict.evidence }, logger.getLogPath()), blocked: true };
  }

  /**
   * One pass through the install. Returns what happened without telling the
   * renderer it failed; the callers above decide when a failure is final.
   */
  private async runInstallAttempt(mode: InstallMode = 'partial'): Promise<InstallResult> {
    // Warnings belong to the attempt that raised them; a retry raises its own.
    this.warnings = [];
    if (this.isCancelled) {
      return CANCELLED;
    }

    try {
      // The vendor decides the torch flavor, the vsjetpack extras and which
      // inference backends get installed. Persist the detection immediately;
      // pluginsGpuVendor is only written once the install actually succeeds.
      const vendor = await detectGpuVendor(configManager.getGpuVendor());
      await configManager.setGpuVendor(vendor);
      logger.info(`Installing for GPU vendor: ${vendor}`);

      this.sendProgress({
        type: 'installing',
        progress: 0,
        message: `Preparing to install Python packages from PyPI (GPU vendor: ${vendor})...`
      });

      const refusal = await this.preflight(vendor);
      if (refusal) {
        return refusal;
      }

      logger.info('Starting plugin dependency installation...');

      // Runs before any pip install: an unreadable dist-info aborts pip
      // outright, so nothing below can succeed until it is cleared.
      await this.repairEnvironmentIntegrity();

      // Step 0: Ensure setuptools and wheel are installed (0-3% progress)
      logger.info('=== Step 0: Ensuring setuptools and wheel are installed ===');
      const setupResult = await this.runPipInstall(
        'Installing setuptools and wheel',
        ['setuptools', 'wheel'],
        0,
        3,
        ['--upgrade']
      );
      if (!setupResult.success) {
        return setupResult;
      }

      if (this.isCancelled) {
        return CANCELLED;
      }

      // Step 0.4, complete reinstall only: remove the plugin packages so every
      // one installs fresh, which --upgrade alone never does for a damaged
      // package at the version already there. The core runtime stays, as
      // Uninstall leaves it. Non-fatal: the install below repairs what it can.
      if (mode === 'complete') {
        logger.info('=== Step 0.4: Removing plugin packages for a complete reinstall ===');
        this.sendProgress({
          type: 'installing',
          progress: 2,
          message: 'Removing the installed plugin packages for a clean reinstall...'
        });
        const clean = await this.runPipUninstall(UNINSTALL_PACKAGE_NAMES);
        if (!clean.success) {
          logger.warn(`Could not remove every plugin package first (continuing anyway): ${clean.error}`);
        }
        if (this.isCancelled) {
          return CANCELLED;
        }
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
      // The Windows MIGraphX runtime is not a pip package, so the purge above
      // never sees it: drop it here when this machine no longer gets MIGraphX.
      if (process.platform === 'win32' && !getBackendsForVendor(vendor).includes('migraphx')) {
        await MigxRuntimeManager.remove().catch((error) => {
          logger.warn('Failed to remove the MIGraphX runtime (continuing anyway):', error);
        });
      }

      if (this.isCancelled) {
        return CANCELLED;
      }

      // Step 1: PyTorch (3-35% progress) — needed by the bundled (non-PyPI)
      // vs_deepdeinterlace scripts; everything else runs on TensorRT/ONNX Runtime.
      // CUDA wheels on NVIDIA, CPU wheels from the default PyPI index elsewhere.
      logger.info('=== Step 1: Installing PyTorch and torchvision ===');
      const torchInstall = getTorchInstall(vendor);
      const pytorchResult = await this.runPipInstall(
        'Installing PyTorch',
        torchInstall.packages,
        3,
        32,
        torchInstall.extraArgs
      );
      if (!pytorchResult.success) {
        return pytorchResult;
      }

      // A package can retain valid dist-info metadata even when files from its
      // wheel are absent. In that state, an ordinary plugin reinstall is a
      // no-op because pip prints "Requirement already satisfied". Repair the
      // wheel explicitly before continuing; torchgen ships inside torch and
      // must never be installed from the unrelated `torchgen` project on PyPI.
      if (!this.isCancelled && !(await this.checkTorchRuntime()).ok) {
        logger.warn('PyTorch runtime is incomplete; repairing torch and torchvision in place');
        this.sendProgress({
          type: 'installing',
          progress: 32,
          message: 'Repairing the PyTorch installation...'
        });

        const repairResult = await this.runPipInstall(
          'Repairing PyTorch',
          torchInstall.packages,
          32,
          3,
          // Do not uninstall the partial wheel first: a previously successful
          // short-prefix install can itself contain paths that are too long to
          // remove through the normal prefix. Overwrite it from the complete
          // cached wheel instead.
          [...torchInstall.extraArgs, '--ignore-installed']
        );
        if (!repairResult.success) {
          return repairResult;
        }
        const recheck = await this.checkTorchRuntime();
        if (!recheck.ok) {
          return failureResult(describeTorchImportFailure(recheck.error), logger.getLogPath());
        }
      }

      if (this.isCancelled) {
        return CANCELLED;
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
        return CANCELLED;
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
        'Installing the VapourSynth plugin packages',
        pypiPackages,
        40,
        40,
        ['--upgrade', ...PYPI_EXTRA_INDEX_ARGS]
      );
      if (!pypiResult.success) {
        return pypiResult;
      }

      // Packages whose declared dependencies this vendor cannot use - off
      // NVIDIA, vs_undistort's 3.8 GB TensorRT stack (getNoDepsPackages).
      const noDepsPackages = getNoDepsPackages(vendor);
      if (noDepsPackages.length > 0 && !this.isCancelled) {
        const noDepsResult = await this.runPipInstall(
          'Installing the remaining plugin packages',
          noDepsPackages,
          80,
          2,
          ['--upgrade', '--no-deps', ...PYPI_EXTRA_INDEX_ARGS]
        );
        if (!noDepsResult.success) {
          return noDepsResult;
        }
      }

      // Remove plugin builds that crash VapourSynth autoload and resolve the
      // ort/ort-cuda duplicate in favor of the build this vendor can use
      await applyPluginCompatibilityFixes(vendor);

      if (this.isCancelled) {
        return CANCELLED;
      }

      // Step 4: VapourSynth scripts, from every source in scriptSources.ts
      // (85-90% progress). A reinstall restores the shipped files, backing up
      // any the user edited. Not fatal: the Hybrid scripts come from GitHub,
      // and failing a whole install - torch and all - over them strands the
      // user with nothing. Only the filters importing a missing script are
      // affected, and the next launch retries the source. This step cannot be
      // aborted part-way (scriptSync takes no signal); it is a few MB, and the
      // cancel is honoured as soon as it returns.
      logger.info('=== Step 4: Syncing VapourSynth scripts ===');
      // A partial reinstall keeps edited scripts, as an app update does; a
      // complete one restores the shipped files, backing up edited ones.
      const scripts = await syncInstalledScripts(mode === 'complete' ? 'install' : 'update', (message) => {
        this.sendProgress({ type: 'installing', progress: 87, message });
      });
      await removeSupersededScripts();
      for (const failure of scripts.failed) {
        this.warn(
          `Some VapourSynth scripts could not be installed (${failure.error}); a few filters may not work until the next launch retries.`,
          88,
        );
      }

      if (this.isCancelled) {
        return CANCELLED;
      }

      // Step 4.5: vs-mlrt model zoo for the bundled RIFE/DPIR templates (the
      // pip wheels ship no models folder). Non-fatal: a download failure only
      // affects those templates, and startup re-attempts it (checkDependencies).
      if (await VsMlrtModelsManager.needsDownload()) {
        logger.info('=== Step 4.5: Downloading vs-mlrt model zoo (RIFE/DPIR) ===');
        try {
          await VsMlrtModelsManager.ensureModels((message) => {
            this.sendProgress({ type: 'installing', progress: 90, message });
          }, this.abortController?.signal);
        } catch (error) {
          if (this.isCancelled) {
            return CANCELLED;
          }
          logger.warn('vs-mlrt model zoo download failed (continuing; retried at next startup):', error);
        }
      }

      // Step 4.55: MIGraphX on Windows. No pip index carries it, so the plugin
      // and its HIP runtime come from the vs-mlrt GitHub release. Non-fatal
      // like the model zoo: only the MIGraphX backend is affected, and startup
      // re-attempts it (checkDependencies).
      if (process.platform === 'win32' && getBackendsForVendor(vendor).includes('migraphx')
        && await MigxRuntimeManager.needsInstall()) {
        logger.info('=== Step 4.55: Installing the MIGraphX runtime ===');
        try {
          await MigxRuntimeManager.ensureRuntime((message) => {
            this.sendProgress({ type: 'installing', progress: 91, message });
          }, this.abortController?.signal);
        } catch (error) {
          if (this.isCancelled) {
            return CANCELLED;
          }
          logger.warn('MIGraphX runtime install failed (continuing; retried at next startup):', error);
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
        return CANCELLED;
      }

      // Step 5: Copy filter templates (95-100% progress)
      logger.info('=== Step 5: Copying filter templates ===');
      await installPluginTemplates(mode, () => this.sendProgress({
        type: 'installing',
        progress: 95,
        message: 'Copying filter templates...'
      }));

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

      // Step 8: trim the pip cache. Only here: this runs inside the one
      // operation this class allows at a time, after its last pip has exited,
      // so nothing of ours is writing to the cache while it goes.
      await prunePipCache(PATHS.PIP_CACHE, PIP_CACHE_LIMIT_BYTES);

      // All installations complete
      logger.info('All plugin dependencies and plugins installed successfully');
      logger.info('='.repeat(50));
      logger.info('✓ All dependencies installed successfully!');
      logger.info('='.repeat(50));
      this.sendProgress({
        type: 'complete',
        progress: 100,
        message: 'Dependencies installed successfully!',
        warnings: this.warnings.length > 0 ? [...this.warnings] : undefined,
      });
      return { success: true };
    } catch (error) {
      if (this.isCancelled) {
        return CANCELLED;
      }
      logger.error('Plugin dependency installation error:', error);
      return failureResult(describeInstallFailure(error, 'Installing plugins'), logger.getLogPath());
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

    // Distribution metadata alone is insufficient: `pip list` reports what a
    // dist-info claims, so a half-finished install still reads as present. The
    // structural scan catches those — a wheel whose files never arrived, or
    // whose metadata pip can no longer read — for every package rather than
    // just torch, and costs file lookups rather than a Python import.
    const integrity = await inspectPythonEnvironment(PATHS.SITE_PACKAGES);
    const runtimeProblems = brokenProjectNames(integrity);

    const state = evaluateInstallState(
      vendor,
      configManager.getPluginsGpuVendor(),
      [...missingNames, ...runtimeProblems]
    );

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
    for (const problem of integrity.problems) {
      logger.info(`Damaged package ${problem.project}: ${problem.detail}`);
    }

    return { installed: state.installed, packages: foundPackages };
  }

  async uninstallDependencies(): Promise<InstallResult> {
    return this.flights.run('uninstall', async () => {
      this.beginOperation();
      const result = await this.withEnvironment('plugin uninstall', () => this.runUninstall());
      this.emitFailure(result);
      return result;
    }, running => this.busyResult(running));
  }

  private async runUninstall(): Promise<InstallResult> {
    logger.info('Starting plugin dependency uninstallation');
    const step = 'Uninstalling plugins';

    try {
      this.sendProgress({
        type: 'installing',
        progress: 0,
        message: 'Preparing to uninstall dependencies...'
      });

      // Shared, deliberately vendor-neutral list — see the comment on
      // UNINSTALL_PACKAGE_NAMES in vendorPackages.ts for why this must NOT
      // branch on the GPU vendor.
      let progress = 0;
      const processLine = (trimmed: string) => {
        const uninstalling = trimmed.match(/^Uninstalling\s+([^\s-]+)/);
        if (uninstalling) {
          progress += 15;
          this.sendProgress({
            type: 'installing',
            progress: Math.min(progress, 95),
            message: `Uninstalling ${uninstalling[1]}...`
          });
          return;
        }
        const uninstalled = trimmed.match(/Successfully uninstalled\s+([^\s-]+)/);
        if (uninstalled) {
          this.sendProgress({
            type: 'installing',
            progress: Math.min(progress, 95),
            message: `Uninstalled ${uninstalled[1]}`
          });
        }
      };

      const outcome = await pipUninstall(UNINSTALL_PACKAGE_NAMES, {
        step,
        shortPrefix: true,
        onLine: processLine,
        signal: this.abortController?.signal,
      });
      if (outcome.cancelled || this.isCancelled) {
        logger.info('Plugin dependency uninstallation cancelled');
        return { ...CANCELLED, error: 'Uninstallation cancelled by user' };
      }
      if (!outcome.ok) {
        return failureResult(outcome.failure!, logger.getLogPath());
      }
      logger.info('Dependencies uninstalled successfully');
      this.sendProgress({
        type: 'complete',
        progress: 100,
        message: 'Dependencies uninstalled successfully!'
      });
      return { success: true };
    } catch (error) {
      logger.error('Plugin dependency uninstallation error:', error);
      return failureResult(describeInstallFailure(error, step), logger.getLogPath());
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

  /**
   * Stops whatever install or uninstall is running, at whatever step it is
   * on: a running pip is killed, a download is aborted, and every step
   * boundary checks the flag before starting the next. The operation's
   * promise settles once it has actually stopped, which is what the Plugins
   * window waits for before showing itself idle again.
   */
  cancel(): void {
    if (!this.flights.running) {
      return;
    }
    logger.info('Cancelling plugin dependency operation');
    this.isCancelled = true;
    // Kills a running pip and releases a wait for the environment lock.
    this.abortController?.abort();
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

    const expected: string[] = [];
    for (let i = 0; i < archiveFiles.length; i++) {
      if (this.isCancelled) {
        return;
      }

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
        await extract7z(archivePath, PATHS.PLUGINS, {
          skipExisting: true,
          onLockedRetry: (attempt, attempts) =>
            logger.info(`${archiveFile} is locked (attempt ${attempt}/${attempts}), retrying...`),
        });
        logger.info(`Successfully extracted ${archiveFile}`);
        expected.push(...await this.archiveContents(archivePath));
      } catch (error) {
        // Other archives are still worth extracting, but this one's plugins
        // are missing and the filters using them will not load, so the user
        // hears about it instead of finding out from a broken filter.
        logger.error(`Failed to extract ${archiveFile}:`, error);
        const message = error instanceof Error ? error.message : String(error);
        const classified = classifyInstallError(message, { step: `Extracting ${archiveFile}` });
        this.warn(
          classified.kind === 'unknown'
            ? `Extracting ${archiveFile} failed (${message}); the plugins in it are missing and filters that use them will not load.`
            : `${classified.summary} Until then, the plugins in ${archiveFile} are missing.`,
          progress,
        );
      }
    }

    await this.reportVanishedPlugins(expected);
    logger.info('Plugin extraction completed');
  }

  /** The files an archive holds, or none if it cannot be listed (verification is then skipped for it). */
  private async archiveContents(archivePath: string): Promise<string[]> {
    try {
      return archiveFileNames(await _7z.list(archivePath));
    } catch (error) {
      logger.warn(`Could not list ${archivePath} to verify its extraction:`, error);
      return [];
    }
  }

  /**
   * Checks that what extraction wrote is still there. Antivirus quarantines
   * some of these DLLs moments after they are written (issue #11), and the
   * install used to carry on as if nothing happened, leaving filters that
   * fail at load time with nothing pointing at the cause.
   *
   * Real-time scanners act on a file as it is closed, but removal can land a
   * little later, so the check waits briefly first rather than racing it.
   */
  private async reportVanishedPlugins(expected: string[]): Promise<void> {
    if (expected.length === 0) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 1500));

    const missing: string[] = [];
    for (const file of expected) {
      if (!await fs.pathExists(path.join(PATHS.PLUGINS, file))) {
        missing.push(file);
      }
    }
    const warning = describeVanishedFiles(missing, PATHS.PLUGINS);
    if (warning) {
      logger.warn(`Plugin files missing right after extraction: ${missing.join(', ')}`);
      this.warn(warning, 40);
    }
  }
}
