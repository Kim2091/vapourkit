import * as path from 'path';
import * as fs from 'fs-extra';
import * as crypto from 'crypto';
import { app, BrowserWindow} from 'electron';
import { ModelExtractor } from './modelExtractor';
import { VsMlrtModelsManager } from './vsMlrtModelsManager';
import { MigxRuntimeManager } from './migxRuntimeManager';
import { ensureTrtexecShim } from './trtexecShim';
import { logger } from './logger';
import * as os from 'os';
import { pipInstall, probePip, QUICK_PIP_NETWORK_ARGS, runGetPip, throwIfFailed, withPipLock } from './pip';
import {
  PATHS,
  PYTHON_VERSION,
  IS_WINDOWS,
  PYPI_EXTRA_INDEX_ARGS,
  VAPOURSYNTH_PIP_SPEC,
  VAPOURSYNTH_VERSION,
} from './constants';
import { readInstalledProjects, unmetRequirements } from './launchRequirements';
import { getBackendsForVendor, getNoDepsPackages, getPypiPackages } from './vendorPackages';
import { staleScriptSources, syncInstalledScripts } from './scriptSync';
import { downloadToFile } from './download';
import { APP_OWNED_PLUGIN_ARCHIVES, shouldExtractBundledPluginArchives } from './bundledPluginArchives';
import { CORE_SETUP_REQUIRED_BYTES, CORE_SETUP_REQUIRED_TEMP_BYTES, runInstallPreflight } from './installPreflight';
import {
  describeInstallFailure,
  describeVanishedFiles,
  embeddedPythonRequiredFiles,
  InstallBlockedError,
  judgePipProbe,
  judgePreflight,
  missingEmbeddedPythonFiles,
  SingleFlight,
} from './installFlow';
import { runCommand, getBundledBasePath, resolveSupportedPythonCommand } from './utils';
import { FFmpegManager } from './ffmpegManager';
import { configManager } from './configManager';
import { applyPluginCompatibilityFixes, migrateLegacyPortableLayout } from './legacyCleanup';
import { findProjectsNeedingNewerCore, isNewerThanPin, readInstalledVapourSynthVersion } from './vapoursynthPin';
import { LINUX_PLUGIN_FILTER_CATALOG_REVISION, needsLinuxPluginFilterCatalogSync } from './pluginFilterCatalog';
import type { TemplateDecision } from './templateReconcile';
import {
  getMissingBundledTemplates,
  getTemplateDecisions,
  reconcileTemplates,
  resolveTemplateDecision,
  restoreMissingBundledTemplates,
} from './templateInstaller';
import {
  emptyReportDraft,
  isEmptyDraft,
  mergeUpdateReport,
  readLedger,
  writeLedger,
  type UpdateReportDraft,
} from './installLedger';
import * as _7z from '7zip-min';
import { extract7z } from './archive';

export interface DownloadProgress {
  // 'warning' is worth showing but stops nothing; 'error' ends setup.
  type: 'download' | 'extract' | 'complete' | 'error' | 'warning' | 'python-setup' | 'model-extract';
  component: string;
  progress: number;
  message: string;
  /** On 'error': the one sentence to show, the lines it came from, and the log */
  summary?: string;
  evidence?: string;
  logPath?: string;
}

interface ComponentConfig {
  name: string;
  url: string;
  archiveName: string;
  checkPath: string;
  extractTo: string;
}

export class DependencyManager {
  private mainWindow: BrowserWindow | null;
  private modelExtractor: ModelExtractor;

  constructor(mainWindow: BrowserWindow | null = null) {
    this.mainWindow = mainWindow;
    this.modelExtractor = new ModelExtractor();
    
    logger.dependency(`Initialized with appDataPath: ${PATHS.APP_DATA}`);
  }

  private sendProgress(progress: DownloadProgress) {
    if (this.mainWindow) {
      this.mainWindow.webContents.send('setup-progress', progress);
    }
  }

  private async setupEmbeddedPython(): Promise<void> {
    logger.dependency(`Setting up ${IS_WINDOWS ? 'embedded Python' : 'a Python virtual environment'}`);

    this.sendProgress({
      type: 'python-setup',
      component: 'Python Embedded',
      progress: 0,
      message: `Setting up ${IS_WINDOWS ? 'embedded Python' : 'a Python virtual environment'} for VapourSynth...`
    });

    const missingEmbedFiles = IS_WINDOWS ? await this.missingEmbeddedPythonFiles() : [];
    if (IS_WINDOWS && missingEmbedFiles.length > 0 && await fs.pathExists(PATHS.PYTHON)) {
      // python.exe on its own is what an extraction interrupted part-way
      // leaves behind, and checking for it alone skipped re-extraction
      // forever. Extracting again over it replaces what is there and fills in
      // what is not; site-packages is not in the zip and is left alone.
      logger.dependency(`Embedded Python is incomplete (missing ${missingEmbedFiles.join(', ')}); extracting it again`);
    }

    if (IS_WINDOWS ? missingEmbedFiles.length > 0 : !await fs.pathExists(PATHS.PYTHON)) {
      if (!IS_WINDOWS) {
        this.sendProgress({
          type: 'python-setup',
          component: 'Python Embedded',
          progress: 10,
          message: 'Creating a Python 3 virtual environment...'
        });
        const pythonResolution = await resolveSupportedPythonCommand();
        if (!pythonResolution.command) {
          const detected = pythonResolution.candidates
            .map(candidate => `${candidate.command}${candidate.version ? ` (Python ${candidate.version})` : ''}`)
            .join(', ');
          if (detected) {
            throw new Error(`Python 3.12, 3.13, or 3.14 with venv support is required on Linux, but the detected interpreters are unsupported: ${detected}. Install a supported Python and python3-venv with your distribution package manager, then restart Vapourkit.`);
          }
          throw new Error('Python 3.12, 3.13, or 3.14 with venv support is required on Linux, but no python3 or python executable was found in the desktop session PATH. Install Python and python3-venv, ensure the interpreter is visible to the desktop session, then restart Vapourkit.');
        }
        logger.dependency(`Using host Python ${pythonResolution.command} (${pythonResolution.version})`);
        await runCommand(pythonResolution.command, ['-m', 'venv', PATHS.VS], PATHS.APP_DATA, undefined, {
          step: 'Creating the Python virtual environment',
        });
        logger.dependency(`Python virtual environment created at: ${PATHS.VS}`);
      } else {
        this.sendProgress({
          type: 'python-setup',
          component: 'Python Embedded',
          progress: 10,
          message: `Downloading Python ${PYTHON_VERSION} embedded...`
        });

        const pythonZipPath = path.join(PATHS.APP_DATA, `python-${PYTHON_VERSION}-embed-amd64.zip`);
        logger.dependency(`Downloading Python ${PYTHON_VERSION}`);

        await this.downloadFile(
          `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`,
          pythonZipPath,
          'Python Embedded'
        );

        this.sendProgress({
          type: 'python-setup',
          component: 'Python Embedded',
          progress: 40,
          message: 'Extracting Python...'
        });

        await this.extractArchive(pythonZipPath, PATHS.VS, 'Python Embedded');
        await fs.remove(pythonZipPath);
        logger.dependency('Python extracted successfully');
      }
    } else {
      logger.dependency(`Python runtime already exists at: ${PATHS.PYTHON}`);
    }

    this.sendProgress({
      type: 'python-setup',
      component: 'Python Embedded',
      progress: 50,
      message: 'Configuring Python paths...'
    });

    if (IS_WINDOWS) {
      // Rewrite pythonXY._pth with the import roots the app relies on. This runs
      // on every setup (not just fresh installs) so existing installs pick up path
      // changes — site-packages must come before vs-scripts so pip-installed
      // packages win over bundled scripts. (A Linux venv would get vs-scripts via
      // a .pth file in site-packages instead.)
      const pythonXY = PYTHON_VERSION.split('.').slice(0, 2).join('');
      const pthFilePath = path.join(PATHS.VS, `python${pythonXY}._pth`);
      await fs.writeFile(pthFilePath, `python${pythonXY}.zip\n.\nLib\\site-packages\nvs-scripts\n`, 'utf8');
      logger.dependency('Python paths configured');
    } else {
      // A venv reads .pth files from site-packages. This makes bundled scripts
      // importable without mutating the host Python or relying on PYTHONPATH.
      await fs.ensureDir(PATHS.SITE_PACKAGES);
      await fs.writeFile(path.join(PATHS.SITE_PACKAGES, 'vapourkit-vs-scripts.pth'), `${PATHS.SCRIPTS}\n`, 'utf8');
      logger.dependency('Python virtual environment paths configured');
    }

    await fs.ensureDir(PATHS.SCRIPTS);

    // Remove leftovers from the old zip-based install (VapourSynth R72 portable
    // runtime, vs-plugins DLL folder, superseded script modules).
    await migrateLegacyPortableLayout();

    // Install pip if missing, or if it is there but will not run: a pip
    // folder whose package is damaged passed the old folder check and then
    // failed every install with "No module named pip" (vapourkit-nightly#1).
    const pipFolderExists = await fs.pathExists(path.join(PATHS.SITE_PACKAGES, 'pip'));
    if (!pipFolderExists || judgePipProbe(await probePip()) === 'repair-pip') {
      await this.bootstrapPip('Python Embedded');
    }

    this.sendProgress({
      type: 'python-setup',
      component: 'Python Embedded',
      progress: 85,
      message: 'Installing VapourSynth from PyPI...'
    });

    // Install the core VapourSynth runtime (vspipe.exe, VSScript, core DLLs all
    // ship in the wheel) plus BestSource so the app can probe videos even if the
    // plugin install phase is skipped. The plugin phase installs everything else.
    logger.dependency('Installing VapourSynth and BestSource from PyPI');
    throwIfFailed(await pipInstall([VAPOURSYNTH_PIP_SPEC, 'vapoursynth-bestsource'], {
      step: 'Installing VapourSynth',
      extraArgs: ['--upgrade'],
    }), 'Installing VapourSynth');

    if (!IS_WINDOWS) {
      await this.configureVapourSynthForVenv();
    }

    this.sendProgress({
      type: 'python-setup',
      component: 'Python Embedded',
      progress: 100,
      message: 'Python runtime configured successfully'
    });

    logger.dependency('Python runtime setup completed');
  }

  /**
   * Reinstalls the VapourSynth core at the pin when a newer one is found.
   *
   * Only NEWER is corrected. Older installs are the ones the `--upgrade` in
   * setup already moves forward, and a core below the pin at least predates
   * the ABI break the pin is guarding; a core above it is unverified ground.
   * Plugins whose metadata needs a newer core go along with it, so they are
   * stepped down too (findProjectsNeedingNewerCore).
   *
   * Non-fatal: a failed reinstall (offline, index down) logs and lets the app
   * start on the core that is there rather than trapping it on the setup
   * screen, and the check runs again next launch.
   */
  private async enforceVapourSynthPin(): Promise<void> {
    let installed: string | null;
    try {
      installed = await readInstalledVapourSynthVersion(PATHS.SITE_PACKAGES);
    } catch (error) {
      logger.error('Could not read the installed VapourSynth version:', error);
      return;
    }

    if (!installed) {
      logger.dependency('VapourSynth version: unknown (no dist-info) — leaving it alone');
      return;
    }

    logger.dependency(`VapourSynth version: ${installed} (pinned to ${VAPOURSYNTH_VERSION})`);
    const coreTooNew = isNewerThanPin(installed);
    // Checked even when the core is on the pin: a launch from before this
    // check put the core back and left these plugins broken on it.
    const dependents = await findProjectsNeedingNewerCore(PATHS.SITE_PACKAGES).catch((error) => {
      logger.error('Could not read plugin requirements on the VapourSynth core:', error);
      return [] as string[];
    });
    if (!coreTooNew && dependents.length === 0) {
      return;
    }

    const message = coreTooNew
      ? `Reinstalling VapourSynth ${VAPOURSYNTH_VERSION} (found ${installed})...`
      : `Matching plugins to VapourSynth ${VAPOURSYNTH_VERSION}: ${dependents.join(', ')}...`;
    logger.dependency(message);
    if (dependents.length > 0) {
      logger.dependency(`Plugins that need a newer VapourSynth: ${dependents.join(', ')}`);
    }
    this.sendProgress({
      type: 'python-setup',
      component: 'VapourSynth',
      progress: 50,
      message,
    });

    const step = `Reinstalling VapourSynth ${VAPOURSYNTH_VERSION}`;
    // `==` is not satisfied by a newer core, so pip uninstalls it and
    // installs the pin, no --force-reinstall needed. Each dependent named
    // beside it is no longer satisfied by its installed release under that
    // pin, so pip steps it down to one that is; nothing else moves.
    const pinBack = async (projects: string[]) => throwIfFailed(await pipInstall([VAPOURSYNTH_PIP_SPEC, ...projects], {
      step,
      // The plugin phase installs from these too, so a dependent may live there.
      extraArgs: projects.length > 0 ? PYPI_EXTRA_INDEX_ARGS : [],
    }), step);

    try {
      await pinBack(dependents);
      logger.dependency(`VapourSynth pinned back to ${VAPOURSYNTH_VERSION}` +
        (dependents.length > 0 ? ` with ${dependents.join(', ')}` : ''));
    } catch (error) {
      logger.error(`Failed to pin VapourSynth back to ${VAPOURSYNTH_VERSION}` +
        (dependents.length > 0 ? ` with ${dependents.join(', ')}` : '') + ':', error);
      // A dependent with no release that works on the pin fails the whole
      // resolve; the core on its own is still worth putting back.
      if (coreTooNew && dependents.length > 0) {
        try {
          await pinBack([]);
          logger.dependency(`VapourSynth pinned back to ${VAPOURSYNTH_VERSION} (plugins left as they were)`);
        } catch (coreError) {
          logger.error(`Failed to pin VapourSynth back to ${VAPOURSYNTH_VERSION}:`, coreError);
        }
      }
    }
  }

  /**
   * Brings an existing environment up to the package list this release asks
   * for - see launchRequirements.ts. An update keeps data\, so this is the only
   * way a package added or raised in a release reaches anyone who updated.
   *
   * Only for an install whose plugin phase ran, and against the vendor that
   * phase installed for, so launch never starts a plugin install nobody asked
   * for or switches an install's GPU flavour. The core is left to its own pin.
   *
   * No --upgrade: only the unmet specs move, and anything already satisfying
   * them stays put. The core pin rides along so no dependency can drag
   * VapourSynth past it. Non-fatal: a failure logs, the app starts, and the
   * attempt waits a day before running again, so an offline machine is not
   * held up by pip on every launch.
   */
  private async ensurePackageRequirements(report: UpdateReportDraft): Promise<void> {
    const vendor = configManager.getPluginsGpuVendor();
    const installed = await readInstalledProjects(PATHS.SITE_PACKAGES);
    if (!vendor || !installed.has('vsjetpack')) return;

    const unmet = unmetRequirements(installed, getPypiPackages(vendor))
      .filter(requirement => requirement.project !== 'vapoursynth');
    // Installed separately with --no-deps, as the plugin phase does.
    const unmetNoDeps = unmetRequirements(installed, getNoDepsPackages(vendor));
    if (unmet.length === 0 && unmetNoDeps.length === 0) return;

    const resolvedSpecs = unmet.map(requirement => requirement.spec);
    const noDepsSpecs = unmetNoDeps.map(requirement => requirement.spec);
    const specs = [...resolvedSpecs, ...noDepsSpecs];
    const ledger = await readLedger();
    const lastFailure = ledger.packageFailure;
    if (lastFailure && Date.now() - Date.parse(lastFailure.at) < 24 * 60 * 60 * 1000
      && specs.every(spec => lastFailure.specs.includes(spec))) {
      logger.dependency(`Not retrying ${specs.join(', ')} yet: the last attempt failed at ${lastFailure.at}`);
      return;
    }

    const message = `Installing packages this version needs: ${specs.join(', ')}...`;
    logger.dependency(message);
    this.sendProgress({
      type: 'python-setup',
      component: 'Python packages',
      progress: 50,
      message,
    });

    const step = 'Installing packages this version needs';
    const install = async (extraArgs: string[], packages: string[]) => throwIfFailed(await pipInstall(packages, {
      step,
      networkArgs: QUICK_PIP_NETWORK_ARGS,
      extraArgs: [...PYPI_EXTRA_INDEX_ARGS, ...extraArgs],
    }), step);

    try {
      if (resolvedSpecs.length > 0) {
        await install([], [VAPOURSYNTH_PIP_SPEC, ...resolvedSpecs]);
      }
      if (noDepsSpecs.length > 0) {
        await install(['--no-deps'], noDepsSpecs);
      }
      report.packagesInstalled.push(...specs);
      delete ledger.packageFailure;
      logger.dependency(`Installed ${specs.join(', ')}`);
    } catch (error) {
      ledger.packageFailure = { at: new Date().toISOString(), specs };
      logger.error(`Failed to install ${specs.join(', ')} (will retry in a day):`, error);
    }
    await writeLedger(ledger);
  }

  /** The embedded-Python files that are missing or empty (Windows only). */
  private async missingEmbeddedPythonFiles(): Promise<string[]> {
    const present = new Map<string, boolean>();
    for (const file of embeddedPythonRequiredFiles(PYTHON_VERSION)) {
      try {
        const stat = await fs.stat(path.join(PATHS.VS, file));
        present.set(file, stat.isFile() && stat.size > 0);
      } catch {
        present.set(file, false);
      }
    }
    return missingEmbeddedPythonFiles(PYTHON_VERSION, file => present.get(file) === true);
  }

  /** get-pip.py, as a fresh setup installs pip. Throws if it fails. */
  private async bootstrapPip(component: string): Promise<void> {
    this.sendProgress({
      type: 'python-setup',
      component,
      progress: 60,
      message: 'Downloading pip installer...'
    });

    const getPipPath = path.join(PATHS.APP_DATA, 'get-pip.py');
    await this.downloadFile(
      'https://bootstrap.pypa.io/get-pip.py',
      getPipPath,
      'pip installer'
    );

    this.sendProgress({
      type: 'python-setup',
      component,
      progress: 70,
      message: 'Installing pip...'
    });

    logger.dependency('Installing pip');
    try {
      throwIfFailed(await runGetPip(getPipPath, { step: 'Installing pip' }), 'Installing pip');
    } finally {
      await fs.remove(getPipPath).catch(() => undefined);
    }
  }

  /**
   * Launch-time counterpart of setup's pip check. Every file check can pass
   * while pip itself is broken, and then the first thing to find out is the
   * plugin install, halfway through. Non-fatal: a repair that fails (offline,
   * say) is logged, the app starts, and the next launch tries again.
   */
  private async ensurePipWorks(): Promise<void> {
    const probe = await probePip();
    const health = judgePipProbe(probe);
    if (health === 'healthy') return;

    if (health !== 'repair-pip') {
      // A Python that cannot start is not something get-pip can fix; the
      // embedded-Python check sends such an install back through setup.
      logger.warn(`pip check was ${health}; not reinstalling pip. Output: ${probe.output.trim()}`);
      return;
    }

    logger.warn(`pip does not run (exit code ${probe.exitCode}); reinstalling it. Output: ${probe.output.trim()}`);
    try {
      await this.bootstrapPip('Python Embedded');
      const after = judgePipProbe(await probePip());
      logger.dependency(`pip reinstalled; it is now ${after}`);
    } catch (error) {
      logger.error('Could not reinstall pip (will try again next launch):', error);
    }
  }

  /**
   * On Linux, VSScript finds Python through a config file that
   * `python -m vapoursynth config` writes; without it vspipe fails with
   * "Failed to initialize VSScript" (issue #10). The Windows wheel needs no
   * config because python.exe sits beside it (the wheel's _has_implicit_config).
   *
   * Confirmed from the R79 wheel's source (vapoursynth/_cli.py, _utils.py):
   * the command exists, writes $XDG_CONFIG_HOME/vapoursynth/vapoursynth.toml
   * (default ~/.config), and reports failure by printing, not by exit code.
   * NOT run on a real Linux machine: whether it finds libpython for every
   * distro's venv is unverified, so it is non-fatal and its output is logged.
   */
  private async configureVapourSynthForVenv(): Promise<void> {
    try {
      const { stdout, stderr } = await runCommand(PATHS.PYTHON, ['-m', 'vapoursynth', 'config'], PATHS.VS, undefined, {
        step: 'Configuring VapourSynth',
      });
      const output = `${stdout}${stderr}`.trim();
      if (/Failed/i.test(output)) {
        logger.warn(`vapoursynth config reported a problem: ${output}`);
      } else {
        logger.dependency(`vapoursynth config: ${output || 'done'}`);
      }
    } catch (error) {
      logger.warn('vapoursynth config failed (vspipe may not find Python):', error);
    }
  }

  /** Whether the VSScript config already names this venv's Python (Linux). */
  private async vapourSynthConfigMentionsVenv(): Promise<boolean> {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    try {
      const config = await fs.readFile(path.join(configHome, 'vapoursynth', 'vapoursynth.toml'), 'utf8');
      return config.includes(PATHS.PYTHON);
    } catch {
      return false;
    }
  }

  /**
   * The launch repairs that run pip, pip itself first because the steps
   * after it need it.
   */
  private async repairEnvironment(report: UpdateReportDraft): Promise<void> {
    await this.ensurePipWorks();
    // Installs from before the setup step existed have no VSScript config
    // on Linux; writing it is one Python start, so only when it is absent.
    if (!IS_WINDOWS && !await this.vapourSynthConfigMentionsVenv()) {
      await this.configureVapourSynthForVenv();
    }
    await this.enforceVapourSynthPin();
    // The post-install plugin fixes, at launch too, so a fix added in a
    // release reaches installs that do not reinstall. Only with the vendor
    // the plugin phase recorded: the fixes decide which ort build to keep.
    const fixVendor = configManager.getPluginsGpuVendor();
    if (fixVendor) {
      await applyPluginCompatibilityFixes(fixVendor).catch((error) =>
        logger.warn('Plugin compatibility fixes failed at launch:', error));
    }
    await this.ensurePackageRequirements(report);
  }

  private readonly checkFlight = new SingleFlight<'check', boolean>();

  /**
   * One check at a time; a caller arriving mid-check shares its result.
   *
   * The renderer can ask twice at once (React runs a mount effect twice in
   * development, and a remount does it anywhere), and two checks racing each
   * other both write the trtexec shim, the ledger and the update report - one
   * rename then finds the other's file already moved, and the whole
   * version-change update is abandoned for that launch.
   */
  checkDependencies(): Promise<boolean> {
    return this.checkFlight.run('check', () => this.runDependencyCheck(), () => false);
  }

  private async runDependencyCheck(): Promise<boolean> {
    logger.dependency('Checking dependencies');

    // vspipe.exe ships inside the VapourSynth wheel (site-packages/vapoursynth),
    // BestSource inside the vapoursynth-bestsource wheel. Old zip-based installs
    // fail these checks and get migrated by re-running setup.
    const vsExists = await fs.pathExists(PATHS.VSPIPE);
    const bsExists = await fs.pathExists(PATHS.BESTSOURCE_DLL);
    // On Windows, the embed as a whole: python.exe alone survives an
    // interrupted extraction (see setupEmbeddedPython).
    const pythonExists = IS_WINDOWS
      ? (await this.missingEmbeddedPythonFiles()).length === 0
      : await fs.pathExists(PATHS.PYTHON);
    // video-compare has an official bundled Windows binary only. On Linux it
    // remains optional and is launched from PATH when the user installs it.
    const videoCompareExists = IS_WINDOWS ? await fs.pathExists(PATHS.VIDEO_COMPARE_EXE) : true;
    const ffmpegExists = await FFmpegManager.isInstalled();
    // NOTE: vs-mlrt (ort/trt) is installed by the plugin phase and intentionally
    // not part of the core health check, so "continue without plugins" installs
    // don't get forced back into setup on every launch.
    // NOTE: No longer checking if models are converted - they will be initialized on-demand

    logger.dependency(`VapourSynth (pip): ${vsExists}`);
    logger.dependency(`BestSource (pip): ${bsExists}`);
    logger.dependency(`Python: ${pythonExists}`);
    logger.dependency(`Video Compare: ${videoCompareExists}`);
    logger.dependency(`FFmpeg: ${ffmpegExists}`);

    const coreDepsPresent = vsExists && bsExists && pythonExists && videoCompareExists && ffmpegExists;

    // The VapourSynth core is pinned. Put back any newer one BEFORE the rest of
    // the launch healing runs, so nothing else starts against a core the
    // shipped filters were never checked on.
    // What this launch changes in an existing install, for the post-update notice.
    const report = emptyReportDraft();

    if (coreDepsPresent) {
      await withPipLock(() => this.repairEnvironment(report), { label: 'launch environment check' });
    }

    // If core deps are healthy, silently extract any missing bundled ONNX models rather than
    // failing the health check and forcing the user through the full setup flow.
    // Model extraction is just a fast local file copy (ASAR → data/models), never a download.
    if (coreDepsPresent && await this.modelExtractor.needsExtraction()) {
      logger.dependency('Core deps present but some bundled ONNX models are missing — extracting silently');
      try {
        await this.modelExtractor.extractModels();
        logger.dependency('Silent model extraction complete');
      } catch (extractError) {
        logger.error('Silent model extraction failed:', extractError);
        // Non-fatal: don't block app startup over a model copy failure
      }
    }

    // Heal missing vs-mlrt zoo models (RIFE/DPIR templates) in the background —
    // a ~75MB download, so deliberately NOT awaited: startup stays fast and the
    // templates start working once it completes. Existing installs predate this
    // download (the old zip-based vs-mlrt shipped the models, pip wheels don't).
    if (coreDepsPresent && await VsMlrtModelsManager.needsDownload()) {
      logger.dependency('vs-mlrt model zoo incomplete — downloading in the background');
      VsMlrtModelsManager.ensureModels()
        .then(() => logger.dependency('vs-mlrt model zoo download complete'))
        .catch((error) => logger.error('vs-mlrt model zoo download failed (will retry next launch):', error));
    }

    // Same for the Windows MIGraphX runtime (68 MB, AMD installs only): existing
    // AMD installs predate it, and a release bump replaces it.
    const pluginsVendor = configManager.getPluginsGpuVendor();
    if (coreDepsPresent && process.platform === 'win32' && pluginsVendor
      && getBackendsForVendor(pluginsVendor).includes('migraphx') && await MigxRuntimeManager.needsInstall()) {
      logger.dependency('MIGraphX runtime missing or outdated — installing in the background');
      MigxRuntimeManager.ensureRuntime()
        .then(() => logger.dependency('MIGraphX runtime install complete'))
        .catch((error) => logger.error('MIGraphX runtime install failed (will retry next launch):', error));
    }

    // Keep the trtexec shim (and the engine builder it runs) in step with the
    // installed app — vsmlrt's runtime TensorRT engine builds go through it.
    // Non-fatal: without it only script-side TRT filters are affected.
    if (coreDepsPresent) {
      try {
        await ensureTrtexecShim();
      } catch (shimError) {
        logger.error('Failed to write the trtexec shim (runtime TensorRT engine builds may fail):', shimError);
      }
    }

    // Reconcile bundled files after an app version or Linux catalog revision change.
    if (coreDepsPresent) {
      const currentVersion = app.getVersion();
      const storedVersion = configManager.getAppVersion();
      const needsCatalogSync = needsLinuxPluginFilterCatalogSync(
        configManager.getLinuxPluginFilterCatalogRevision(),
      );
      // In development the version never changes, so an edit to
      // include/preview_server.py would never reach data/config/, which is
      // the copy previewSession.ts actually spawns. Every protocol change
      // would silently run against the old server.
      const devNeedsConfigSync = !app.isPackaged;
      if (storedVersion !== currentVersion || needsCatalogSync || devNeedsConfigSync) {
        const reason = storedVersion !== currentVersion
          ? `App version changed: ${storedVersion || 'none'} → ${currentVersion}`
          : needsCatalogSync
            ? `Linux filter catalog revision changed to ${LINUX_PLUGIN_FILTER_CATALOG_REVISION}`
            : 'Development build — re-syncing generated config files';
        logger.dependency(`${reason} — updating bundled files`);
        try {
          // A dev run only needs the generated config files; copying filter
          // templates on every launch would be wasted work.
          if (storedVersion === currentVersion && !needsCatalogSync) {
            await this.syncGeneratedConfigFiles(getBundledBasePath());
          } else {
            await this.updateBundledFiles(report);
          }
          if (storedVersion !== currentVersion) {
            // Every update gets a report, even one that changed nothing: that
            // data was kept is itself the thing to tell someone who used to
            // lose it on every update.
            await mergeUpdateReport(report, storedVersion ?? null, currentVersion);
            await configManager.setAppVersion(currentVersion);
          }
          if (needsCatalogSync) {
            await configManager.setLinuxPluginFilterCatalogRevision(LINUX_PLUGIN_FILTER_CATALOG_REVISION);
          }
          logger.dependency('Bundled files updated for new version');
        } catch (updateError) {
          logger.error('Failed to update bundled files on version change:', updateError);
          // Non-fatal: don't block startup
        }
      } else {
        // Same version, but a rebuild under it can still ship changed scripts
        // (a same-day nightly); only then is the install's copy synced.
        if (configManager.getPluginsGpuVendor()) {
          try {
            const stale = staleScriptSources((await readLedger()).scripts);
            if (stale.length > 0) {
              logger.dependency(`vs-scripts behind this build: ${stale.join(', ')} - syncing`);
              const scripts = await syncInstalledScripts('update');
              report.scriptsUpdated.push(...scripts.updated, ...scripts.removed);
              report.scriptsKept.push(...scripts.keptEdited);
            }
          } catch (error) {
            logger.warn('Could not sync vs-scripts with this build (retried next launch):', error);
          }
        }
        if (!isEmptyDraft(report)) {
          // Packages topped up on a launch after the update itself (the first
          // attempt was offline, say) still belong in the report.
          await mergeUpdateReport(report, currentVersion, currentVersion).catch(error =>
            logger.warn('Could not record the package install in the update report:', error));
        }
      }
    }

    const allPresent = coreDepsPresent;
    logger.dependency(`All dependencies present: ${allPresent}`);
    
    return allPresent;
  }
  
  async downloadFile(url: string, outputPath: string, componentName: string): Promise<void> {
    logger.dependency(`Downloading ${componentName} from ${url}`);
    logger.dependency(`Output path: ${outputPath}`);

    // downloadToFile settles only once the file is closed and renamed into
    // place, times out a stalled connection instead of hanging on it, and
    // retries; this used to settle on 'finish', with the descriptor still
    // open, which is how a zip reached 7-Zip as "0 bytes, in use".
    await downloadToFile(url, outputPath, {
      label: componentName,
      minBytes: 1024,
      onProgress: ({ received, total }) => {
        const percentCompleted = total ? Math.round((received * 100) / total) : 0;
        this.sendProgress({
          type: 'download',
          component: componentName,
          progress: percentCompleted,
          message: total
            ? `Downloading ${componentName}... ${percentCompleted}%`
            : `Downloading ${componentName}... ${(received / 1048576).toFixed(1)} MB`,
        });
      },
    });
    logger.dependency(`Download completed: ${componentName}`);
  }

  async extractArchive(archivePath: string, outputPath: string, componentName: string): Promise<void> {
    logger.dependency(`Extracting ${componentName} from ${archivePath} to ${outputPath}`);
    this.sendProgress({
      type: 'extract',
      component: componentName,
      progress: 0,
      message: `Extracting ${componentName}...`
    });

    try {
      await extract7z(archivePath, outputPath, {
        onLockedRetry: (attempt, attempts) => {
          logger.dependency(`File locked during extraction (attempt ${attempt}/${attempts}), retrying...`);
          this.sendProgress({
            type: 'extract',
            component: componentName,
            progress: Math.round((attempt / attempts) * 50),
            message: `${componentName} - file locked, retrying (${attempt}/${attempts})...`
          });
        },
      });
    } catch (error) {
      const errorMsg = `Error extracting ${componentName}: ${error instanceof Error ? error.message : String(error)}`;
      logger.error(errorMsg);
      this.sendProgress({
        type: 'error',
        component: componentName,
        progress: 0,
        message: errorMsg
      });
      throw error;
    }

    this.sendProgress({
      type: 'extract',
      component: componentName,
      progress: 100,
      message: `${componentName} extracted successfully`
    });
    logger.dependency(`Extraction completed: ${componentName}`);
  }

  private async downloadAndInstallComponent(config: ComponentConfig): Promise<void> {
    if (await fs.pathExists(config.checkPath)) {
      logger.dependency(`${config.name} already installed`);
      return;
    }

    logger.dependency(`${config.name} not found, downloading`);
    await fs.ensureDir(config.extractTo);
    
    const archivePath = path.join(PATHS.APP_DATA, config.archiveName);
    await this.downloadFile(config.url, archivePath, config.name);
    await this.extractArchive(archivePath, config.extractTo, config.name);
    await fs.remove(archivePath);
  }

  async setupDependencies(): Promise<void> {
    logger.separator();
    logger.dependency('Starting dependency setup process');
    
    try {
      // Linux intentionally uses the distribution-provided FFmpeg. Check this
      // before creating or mutating the app-managed venv so users receive an
      // actionable prerequisite error instead of an impossible install step.
      if (!IS_WINDOWS && !(await FFmpegManager.isInstalled())) {
        throw new Error(FFmpegManager.getHostPrerequisiteMessage());
      }

      await this.preflightCoreSetup();

      // Component configurations (everything else comes from PyPI)
      const components: ComponentConfig[] = IS_WINDOWS ? [
        {
          name: 'Video Compare Tool',
          url: 'https://github.com/pixop/video-compare/releases/download/20250928/video-compare-20250928-win10-x86_64.zip',
          archiveName: 'video-compare.zip',
          checkPath: PATHS.VIDEO_COMPARE_EXE,
          extractTo: PATHS.VIDEO_COMPARE
        }
      ] : [];

      // Install standard components
      for (const component of components) {
        await this.downloadAndInstallComponent(component);
      }

      // Setup the Windows embedded Python or Linux venv + VapourSynth runtime.
      // vs-mlrt (ort/trt) now comes from PyPI during the plugin install phase.
      // Note: We intentionally do NOT update the stored vs-mlrt version here.
      // The version check in the frontend (App.tsx) will detect a mismatch and
      // show a notification modal if there are existing engine files that need
      // rebuilding; the version is only updated after the user acknowledges it.
      await withPipLock(() => this.setupEmbeddedPython(), { label: 'Python setup' });
      
      // Extract bundled ONNX models to AppData
      if (await this.modelExtractor.needsExtraction()) {
        logger.dependency('Extracting bundled ONNX models');
        await this.modelExtractor.extractModels((message, progress) => {
          this.sendProgress({
            type: 'model-extract',
            component: 'ONNX Models',
            progress,
            message
          });
        });
      } else {
        logger.dependency('ONNX models already extracted');
      }

      // Windows downloads FFmpeg; Linux was preflighted above and must retain
      // its host-managed copy.
      if (!(await FFmpegManager.isInstalled())) {
        logger.dependency('Installing standalone FFmpeg');
        await FFmpegManager.install((message, progress) => {
          this.sendProgress({
            type: 'download',
            component: 'FFmpeg',
            progress,
            message
          });
        });
      } else {
        logger.dependency('FFmpeg already installed');
      }

      // Plugin install runs after this method returns, orchestrated by the
      // setup-dependencies IPC handler. The final 'All Dependencies complete'
      // event is emitted from the handler once plugins finish.

      // Initialize user config files
      await this.initializeUserConfig();

      logger.dependency('All dependencies setup completed successfully');
      logger.separator();

    } catch (error) {
      const failure = describeInstallFailure(error, 'Setup');
      logger.error(`Dependency setup failed (${failure.kind}): ${failure.summary}`, error);

      this.sendProgress({
        type: 'error',
        component: 'Setup',
        progress: 0,
        message: `Setup failed: ${failure.summary}`,
        summary: failure.summary,
        evidence: failure.evidence || undefined,
        logPath: logger.getLogPath(),
      });
      throw error;
    }
  }

  /**
   * Refuses a core setup that cannot fit before anything is downloaded, and
   * shows what is only worth knowing. The plugin phase runs its own, larger
   * check before it starts (pluginInstaller.preflight).
   */
  private async preflightCoreSetup(): Promise<void> {
    let problems;
    try {
      problems = await runInstallPreflight({
        dataDir: PATHS.APP_DATA,
        tempDir: os.tmpdir(),
        requiredBytes: CORE_SETUP_REQUIRED_BYTES,
        requiredTempBytes: CORE_SETUP_REQUIRED_TEMP_BYTES,
      });
    } catch (error) {
      logger.warn('Setup preflight could not run; continuing:', error);
      return;
    }

    const verdict = judgePreflight(problems, { action: 'Setup' });
    for (const warning of verdict.warnings) {
      logger.warn(`Setup preflight warning: ${warning.message}`);
      this.sendProgress({ type: 'warning', component: 'Setup', progress: 0, message: warning.message });
    }
    if (verdict.refusal) {
      throw new InstallBlockedError(verdict.refusal, verdict.evidence);
    }
  }

  getVSPipePath(): string {
    return PATHS.VSPIPE;
  }

  getPluginsPath(): string {
    return PATHS.PLUGINS;
  }

  /**
   * Called on version change to overwrite bundled files that must stay in sync with the app.
   * This handles upgrade-in-place scenarios where setupDependencies() is never called.
   */
  private async updateBundledFiles(report: UpdateReportDraft): Promise<void> {
    const bundledBasePath = getBundledBasePath();

    await this.syncGeneratedConfigFiles(bundledBasePath);

    // Seed new filter templates, and update or retire the ones the user has
    // not edited; edited ones are left for the post-update notice
    await reconcileTemplates(bundledBasePath, report);

    await this.refreshAppOwnedPlugins(bundledBasePath, report);

    // vs-scripts is only there once the plugin phase has run; a fresh install
    // gets it there. Edited scripts are kept and reported, never overwritten.
    if (configManager.getPluginsGpuVendor()) {
      const scripts = await syncInstalledScripts('update');
      report.scriptsUpdated.push(...scripts.updated, ...scripts.removed);
      report.scriptsKept.push(...scripts.keptEdited);
    }
  }

  /**
   * Brings the plugins built in this repo up to the bundled build.
   *
   * The ledger records the digest of the archive each was extracted from, so
   * a matching archive whose files are all present costs one hash and no
   * extraction. Without an entry - an install from before the ledger - the
   * files are compared by content, since a DLL rebuilt at the same version is
   * exactly the case skip-existing extraction missed.
   *
   * Only on an install whose plugin phase already ran (the plugins folder
   * exists): a fresh one extracts them there. Non-fatal: a copy that fails, a
   * DLL held open say, logs and is retried on the next update.
   */
  private async refreshAppOwnedPlugins(bundledBasePath: string, report: UpdateReportDraft): Promise<void> {
    if (!shouldExtractBundledPluginArchives() || !await fs.pathExists(PATHS.PLUGINS)) return;

    const ledger = await readLedger();
    for (const archive of APP_OWNED_PLUGIN_ARCHIVES) {
      const archivePath = path.join(bundledBasePath, 'include', 'plugins', archive);
      if (!await fs.pathExists(archivePath)) continue;

      const digest = crypto.createHash('sha256').update(await fs.readFile(archivePath)).digest('hex');
      const entry = ledger.plugins[archive];
      if (entry?.digest === digest
        && (await Promise.all(entry.files.map(file => fs.pathExists(path.join(PATHS.PLUGINS, file))))).every(Boolean)) {
        continue;
      }

      const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'vk-plugin-'));
      try {
        await _7z.unpack(archivePath, staging);
        const files = await fs.readdir(staging);
        for (const file of files) {
          const source = path.join(staging, file);
          const dest = path.join(PATHS.PLUGINS, file);
          if (await fs.pathExists(dest) && (await fs.readFile(source)).equals(await fs.readFile(dest))) continue;
          await fs.copy(source, dest, { overwrite: true });
          report.pluginsUpdated.push(file);
          logger.dependency(`Updated bundled plugin ${file} from ${archive}`);
        }
        ledger.plugins[archive] = { digest, appVersion: app.getVersion(), files };

        // A copy antivirus removes on arrival (issue #11) would otherwise
        // be recorded as installed; the ledger's own file check then
        // re-copies it every launch without anyone learning why.
        const vanished: string[] = [];
        for (const file of files) {
          if (!await fs.pathExists(path.join(PATHS.PLUGINS, file))) vanished.push(file);
        }
        const warning = describeVanishedFiles(vanished, PATHS.PLUGINS);
        if (warning) {
          logger.warn(`Bundled plugin files from ${archive} missing right after copying: ${vanished.join(', ')}`);
          this.sendProgress({ type: 'warning', component: 'Plugins', progress: 0, message: warning });
        }
      } catch (error) {
        logger.warn(`Could not refresh bundled plugin archive ${archive}:`, error);
        this.sendProgress({
          type: 'warning',
          component: 'Plugins',
          progress: 0,
          message: `Updating the bundled plugins from ${archive} failed (${describeInstallFailure(error).summary}); the previous versions stay in use.`,
        });
      } finally {
        await fs.remove(staging).catch(() => undefined);
      }
    }
    await writeLedger(ledger);
  }

  /**
   * Overwrites the config files that are app infrastructure rather than user
   * settings: the placeholder template the script generator fills in, and the
   * preview session's server. Both must match the app version — a template
   * missing a placeholder, or a server that disagrees with previewSession.ts
   * about the protocol, fails at runtime — so neither preserves local edits.
   */
  private async syncGeneratedConfigFiles(bundledBasePath: string): Promise<void> {
    for (const name of ['vapoursynth_template.vpy', 'preview_server.py', 'align_videos.py']) {
      const bundledPath = path.join(bundledBasePath, 'include', name);
      if (!await fs.pathExists(bundledPath)) continue;
      await fs.copy(bundledPath, path.join(PATHS.CONFIG, name), { overwrite: true });
      logger.dependency(`Updated ${name} from bundled source`);
    }
  }

  private async copyTemplateIfNeeded(userPath: string, bundledPath: string, logName: string): Promise<void> {
    if (!await fs.pathExists(userPath)) {
      if (await fs.pathExists(bundledPath)) {
        await fs.copy(bundledPath, userPath);
        logger.dependency(`Created user ${logName}`);
      }
    }
  }

  /** Built-in filters the user deleted in the app; see templateInstaller.ts. */
  getMissingBundledTemplates(): Promise<string[]> {
    return getMissingBundledTemplates();
  }

  /** Puts back every built-in filter the install has deleted; answers the files restored. */
  restoreMissingBundledTemplates(): Promise<string[]> {
    return restoreMissingBundledTemplates();
  }

  /** The edited templates the post-update notice asks about. */
  getTemplateDecisions(): Promise<TemplateDecision[]> {
    return getTemplateDecisions();
  }

  /** Carries out the user's answer about one edited template. */
  resolveTemplateDecision(file: string, choice: 'replace' | 'keep' | 'remove'): Promise<{ backupPath?: string }> {
    return resolveTemplateDecision(file, choice);
  }

  private async initializeUserConfig(): Promise<void> {
    logger.dependency('Initializing user configuration files');
    
    await fs.ensureDir(PATHS.CONFIG);
    
    // Get bundled template paths
    const bundledBasePath = getBundledBasePath();
    logger.dependency(`Bundled templates base path: ${bundledBasePath}`);
    
    // Copy stock app-config.json with pre-configured model metadata
    await this.copyTemplateIfNeeded(
      path.join(PATHS.CONFIG, 'app-config.json'),
      path.join(bundledBasePath, 'include', 'stock-app-config.json'),
      'App configuration'
    );
    
    await this.syncGeneratedConfigFiles(bundledBasePath);

    // Copy filter templates from bundled location
    await reconcileTemplates(bundledBasePath);
    
    logger.dependency('User configuration initialized');

    // Store current app version so future upgrades can detect changes
    await configManager.setAppVersion(app.getVersion());
    if (process.platform === 'linux') {
      await configManager.setLinuxPluginFilterCatalogRevision(LINUX_PLUGIN_FILTER_CATALOG_REVISION);
    }
  }

  getPythonExecutablePath(): string {
    return PATHS.PYTHON;
  }
}
