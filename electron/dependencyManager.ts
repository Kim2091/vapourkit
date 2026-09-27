import * as path from 'path';
import * as fs from 'fs-extra';
import * as crypto from 'crypto';
import * as TOML from '@iarna/toml';
import { app, BrowserWindow} from 'electron';
import { ModelExtractor } from './modelExtractor';
import { VsMlrtModelsManager } from './vsMlrtModelsManager';
import { ensureTrtexecShim } from './trtexecShim';
import { logger } from './logger';
import * as os from 'os';
import { spawn } from 'child_process';
import {
  PATHS,
  PYTHON_VERSION,
  IS_WINDOWS,
  PIP_NETWORK_ARGS,
  PYPI_EXTRA_INDEX_ARGS,
  VAPOURSYNTH_PIP_SPEC,
  VAPOURSYNTH_VERSION,
} from './constants';
import { readInstalledProjects, unmetRequirements } from './launchRequirements';
import { getPypiPackages } from './vendorPackages';
import { syncInstalledScripts } from './scriptSync';
import { downloadToFile } from './download';
import { APP_OWNED_PLUGIN_ARCHIVES, shouldExtractBundledPluginArchives } from './bundledPluginArchives';
import { CORE_SETUP_REQUIRED_BYTES, CORE_SETUP_REQUIRED_TEMP_BYTES, runInstallPreflight } from './installPreflight';
import {
  appendBounded,
  describeInstallFailure,
  describeVanishedFiles,
  embeddedPythonRequiredFiles,
  InstallBlockedError,
  judgePipProbe,
  judgePreflight,
  missingEmbeddedPythonFiles,
  SingleFlight,
  type PipProbe,
} from './installFlow';
import { runCommand, getBundledBasePath, resolveSupportedPythonCommand } from './utils';
import { FFmpegManager } from './ffmpegManager';
import { configManager } from './configManager';
import { migrateLegacyPortableLayout } from './legacyCleanup';
import { isNewerThanPin, readInstalledVapourSynthVersion } from './vapoursynthPin';
import {
  hasPluginFilterTemplates,
  LINUX_PLUGIN_FILTER_CATALOG_REVISION,
  needsLinuxPluginFilterCatalogSync,
  selectPluginFilterTemplates,
  selectUnsupportedLinuxPluginFilterTemplates,
} from './pluginFilterCatalog';
import { shippedTemplateDigest } from './shippedTemplateDigest';
import { SHIPPED_TEMPLATE_DIGESTS } from './shippedTemplateDigests';
import { isDecision, planTemplateReconcile, type TemplateDecision, type TemplateState } from './templateReconcile';
import {
  emptyReportDraft,
  isEmptyDraft,
  mergeUpdateReport,
  readLedger,
  writeLedger,
  type InstallLedger,
  type UpdateReportDraft,
} from './installLedger';
import * as _7z from '7zip-min';

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
  url?: string;
  urls?: string[];  // For multi-part archives (e.g., .7z.001, .7z.002)
  archiveName: string;
  archiveNames?: string[];  // For multi-part archives
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
    if (!pipFolderExists || judgePipProbe(await this.probePip()) === 'repair-pip') {
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
    await runCommand(PATHS.PYTHON, [
      '-m', 'pip', 'install', '--upgrade', '--no-warn-script-location',
      // The same cache the plugin phase uses, so the one prune there covers
      // it; pip's default cache is in the user profile, out of sight.
      '--cache-dir', PATHS.PIP_CACHE,
      ...PIP_NETWORK_ARGS,
      VAPOURSYNTH_PIP_SPEC,
      'vapoursynth-bestsource',
    ], undefined, undefined, { step: 'Installing VapourSynth' });

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
    if (!isNewerThanPin(installed)) {
      return;
    }

    const message = `Reinstalling VapourSynth ${VAPOURSYNTH_VERSION} (found ${installed})...`;
    logger.dependency(message);
    this.sendProgress({
      type: 'python-setup',
      component: 'VapourSynth',
      progress: 50,
      message,
    });

    try {
      // `==` is not satisfied by the newer core, so pip uninstalls it and
      // installs the pin — no --force-reinstall needed, and its dependencies
      // stay where they are.
      await runCommand(PATHS.PYTHON, [
        '-m', 'pip', 'install', '--no-warn-script-location',
        '--cache-dir', PATHS.PIP_CACHE,
        ...PIP_NETWORK_ARGS,
        VAPOURSYNTH_PIP_SPEC,
      ], undefined, undefined, { step: `Reinstalling VapourSynth ${VAPOURSYNTH_VERSION}` });
      logger.dependency(`VapourSynth pinned back to ${VAPOURSYNTH_VERSION}`);
    } catch (error) {
      logger.error(`Failed to pin VapourSynth back to ${VAPOURSYNTH_VERSION}:`, error);
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
    if (unmet.length === 0) return;

    const specs = unmet.map(requirement => requirement.spec);
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

    try {
      await runCommand(PATHS.PYTHON, [
        '-m', 'pip', 'install', '--no-warn-script-location',
        '--cache-dir', PATHS.PIP_CACHE,
        '--retries', '1', '--timeout', '15',
        ...PYPI_EXTRA_INDEX_ARGS,
        VAPOURSYNTH_PIP_SPEC,
        ...specs,
      ], undefined, undefined, { step: 'Installing packages this version needs' });
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

  /**
   * `python -m pip --version`: one interpreter start, about a tenth of a
   * second, and the only check that pip will actually run. The time limit is
   * generous because antivirus scanning a first start can be slow; a probe
   * that runs out of it is inconclusive, not a verdict.
   */
  private probePip(): Promise<PipProbe> {
    return new Promise(resolve => {
      let output = '';
      let settled = false;
      const finish = (probe: PipProbe) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(probe);
      };

      const child = spawn(PATHS.PYTHON, ['-m', 'pip', '--version'], { cwd: PATHS.VS, windowsHide: true });
      const timer = setTimeout(() => {
        child.kill();
        finish({ spawnFailed: false, timedOut: true, exitCode: null, output });
      }, 30_000);
      child.stdout?.on('data', (data: Buffer) => { output = appendBounded(output, data.toString(), 16 * 1024); });
      child.stderr?.on('data', (data: Buffer) => { output = appendBounded(output, data.toString(), 16 * 1024); });
      child.on('error', error => finish({ spawnFailed: true, exitCode: null, output: error.message }));
      child.on('close', code => finish({ spawnFailed: false, exitCode: code, output }));
    });
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
      await runCommand(PATHS.PYTHON, [getPipPath, '--no-warn-script-location', ...PIP_NETWORK_ARGS], PATHS.APP_DATA, undefined, {
        step: 'Installing pip',
      });
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
    const probe = await this.probePip();
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
      const after = judgePipProbe(await this.probePip());
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
      // First, because both of the steps after it run pip.
      await this.ensurePipWorks();
      // Installs from before the setup step existed have no VSScript config
      // on Linux; writing it is one Python start, so only when it is absent.
      if (!IS_WINDOWS && !await this.vapourSynthConfigMentionsVenv()) {
        await this.configureVapourSynthForVenv();
      }
      await this.enforceVapourSynthPin();
      await this.ensurePackageRequirements(report);
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
      } else if (!isEmptyDraft(report)) {
        // Packages topped up on a launch after the update itself (the first
        // attempt was offline, say) still belong in the report.
        await mergeUpdateReport(report, currentVersion, currentVersion).catch(error =>
          logger.warn('Could not record the package install in the update report:', error));
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
    await fs.ensureDir(outputPath);
    
    this.sendProgress({
      type: 'extract',
      component: componentName,
      progress: 0,
      message: `Extracting ${componentName}...`
    });

    const maxRetries = 5;
    const retryDelay = 2000; // 2 seconds
    let lastError: any = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await _7z.unpack(archivePath, outputPath);
        
        this.sendProgress({
          type: 'extract',
          component: componentName,
          progress: 100,
          message: `${componentName} extracted successfully`
        });
        
        logger.dependency(`Extraction completed: ${componentName}`);
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
          logger.dependency(`File locked during extraction (attempt ${attempt}/${maxRetries}), retrying in ${retryDelay}ms...`);
          this.sendProgress({
            type: 'extract',
            component: componentName,
            progress: Math.round((attempt / maxRetries) * 50), // Show partial progress during retries
            message: `${componentName} - file locked, retrying (${attempt}/${maxRetries})...`
          });
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          continue;
        }
        
        // If it's not a file lock error, or we've exhausted retries, throw
        const errorMsg = `Error extracting ${componentName}: ${errorMessage}`;
        logger.error(errorMsg);
        if (attempt === maxRetries) {
          logger.error(`Failed after ${maxRetries} attempts`);
        }
        this.sendProgress({
          type: 'error',
          component: componentName,
          progress: 0,
          message: errorMsg
        });
        throw err;
      }
    }

    // Should never reach here, but just in case
    throw lastError;
  }
  
  private async downloadAndInstallComponent(config: ComponentConfig): Promise<void> {
    if (await fs.pathExists(config.checkPath)) {
      logger.dependency(`${config.name} already installed`);
      return;
    }

    logger.dependency(`${config.name} not found, downloading`);
    await fs.ensureDir(config.extractTo);
    
    // Handle multi-part archives (e.g., .7z.001, .7z.002)
    if (config.urls && config.archiveNames) {
      const archivePaths: string[] = [];
      
      // Download all parts
      for (let i = 0; i < config.urls.length; i++) {
        const archivePath = path.join(PATHS.APP_DATA, config.archiveNames[i]);
        archivePaths.push(archivePath);
        await this.downloadFile(config.urls[i], archivePath, `${config.name} (Part ${i + 1}/${config.urls.length})`);
      }
      
      // Extract using the first part (7zip will automatically find the other parts)
      await this.extractArchive(archivePaths[0], config.extractTo, config.name);
      
      // Clean up all parts
      for (const archivePath of archivePaths) {
        await fs.remove(archivePath);
      }
    } else if (config.url) {
      // Single archive download
      const archivePath = path.join(PATHS.APP_DATA, config.archiveName);
      await this.downloadFile(config.url, archivePath, config.name);
      await this.extractArchive(archivePath, config.extractTo, config.name);
      await fs.remove(archivePath);
    }
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
      await this.setupEmbeddedPython();
      
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

  getModelsPath(): string {
    return PATHS.MODELS;
  }

  getPluginsPath(): string {
    return PATHS.PLUGINS;
  }

  getVSPath(): string {
    return PATHS.VS;
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
    await this.copyFilterTemplates(bundledBasePath, report);

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
    for (const name of ['vapoursynth_template.vpy', 'preview_server.py']) {
      const bundledPath = path.join(bundledBasePath, 'include', name);
      if (!await fs.pathExists(bundledPath)) continue;
      await fs.copy(bundledPath, path.join(PATHS.CONFIG, name), { overwrite: true });
      logger.dependency(`Updated ${name} from bundled source`);
    }
  }

  /**
   * SHA-256 of every shipped Color Grade `code` block whose maths the current
   * app no longer matches.
   *
   * The grade is implemented three times over — this template, the WebGL
   * shader, and the reference in colorGrade.ts — and they have to agree or the
   * preview lies about the render. So when the maths changes, an untouched
   * installed template has to come along. A user's own edits still win: only
   * an exact match to something we shipped is replaced.
   */
  private static readonly SUPERSEDED_GRADE_CODE = new Set([
    // Pre-2.0.1: gain and lift as two steps, which put white at
    // gain + lift * (1 - gain), and a clamp to 1 before pow that threw away
    // highlight headroom.
    '741f8c831597afcdb1f00b09bf57fdcbcdb3aceeb2dc873ac4242dbc16555428',
  ]);

  private async upgradeSupersededGradeTemplate(sourcePath: string, destPath: string): Promise<boolean> {
    try {
      const template = TOML.parse(await fs.readFile(destPath, 'utf-8')) as { name?: string; code?: string };
      if (template.name !== 'Color Grade' || !template.code) return false;

      const code = template.code.replace(/\r\n?/g, '\n').trim();
      const digest = crypto.createHash('sha256').update(code).digest('hex');
      if (!DependencyManager.SUPERSEDED_GRADE_CODE.has(digest)) return false;

      await fs.copy(sourcePath, destPath, { overwrite: true });
      logger.dependency('Updated the unmodified Color Grade template to the current grade maths');
      return true;
    } catch (error) {
      logger.warn('Could not inspect the existing Color Grade template for upgrade:', error);
      return false;
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

  /**
   * Bundled Crop bodies that later releases replaced, by sha256 of the code
   * with line endings normalized and trimmed.
   *
   * Crop shipped as vs_tiletools auto-crop until 2.0.0, lost it when the
   * template was rewritten onto core std.Crop, and has it back now for the
   * all-zero case. An install seeded during either of those releases is still
   * carrying a Crop that silently does nothing when nothing is set.
   */
  private static readonly SUPERSEDED_CROP_CODE = new Set([
    // vs_tiletools, but passing all four zeros, which is its manual mode. The
    // comment above it promised auto-crop; the arguments prevented it.
    '31c8ecddb66c63494f7aa0b22773f80b0662f2c85cbbb575f1274c5c7d619844',
    // 2.0.0: the arguments dropped, so auto-crop worked — and raised on any
    // chain with nothing above it to have done the padding.
    '6be48f6f8ef228f95ca3d75cf57503ee5a951b7a212fb629925b9565337124df',
    // The first std.Crop rewrite: plain numbers, no public variables, no editor.
    'e0784187435aa7907c329baaa409bb2e17d93e07be43aa78ead6deafaa9ea8d6',
    // The same maths, with the visual editor's {{crop_*}} variables added.
    '849c96a9fc7975ade2890f127d4e484617ccc86297588451a6edb210e98c04da',
  ]);

  /**
   * Filter templates normally preserve user edits across upgrades. Crop is the
   * one safe exception: replace a body byte-for-byte identical to one we
   * shipped, so an existing install picks up the visual editor and the
   * restored auto-crop. A customized Crop never matches, and is left alone.
   */
  private async upgradeLegacyCropTemplate(sourcePath: string, destPath: string): Promise<boolean> {
    try {
      const template = TOML.parse(await fs.readFile(destPath, 'utf-8')) as { name?: string; code?: string };
      if (template.name !== 'Crop' || !template.code) return false;

      const code = template.code.replace(/\r\n?/g, '\n').trim();
      const digest = crypto.createHash('sha256').update(code).digest('hex');
      if (!DependencyManager.SUPERSEDED_CROP_CODE.has(digest)) return false;

      await fs.copy(sourcePath, destPath, { overwrite: true });
      logger.dependency('Updated the unmodified Crop template to the current bundled version');
      return true;
    } catch (error) {
      logger.warn('Could not inspect the existing Crop template for upgrade:', error);
      return false;
    }
  }

  /**
   * The bundled templates: the ones this platform seeds, by path, and the name
   * of every one shipped on any platform.
   */
  private async bundledTemplates(bundledBasePath: string): Promise<{ selected: Map<string, string>; all: Set<string> }> {
    const templateDirectories = [
      path.join(bundledBasePath, 'include', 'filter_templates'),
      ...(hasPluginFilterTemplates()
        ? [path.join(bundledBasePath, 'include', 'plugins', 'plugin_filters')]
        : []),
    ];

    const selected = new Map<string, string>();
    const all = new Set<string>();
    for (const templateDirectory of templateDirectories) {
      if (!await fs.pathExists(templateDirectory)) {
        logger.warn(`Bundled filter templates not found at: ${templateDirectory}`);
        continue;
      }

      const sourceFiles = (await fs.readdir(templateDirectory)).filter(f => f.endsWith('.vkfilter'));
      sourceFiles.forEach(file => all.add(file));
      const isPluginCatalog = templateDirectory.endsWith(path.join('plugins', 'plugin_filters'));
      const supported = isPluginCatalog ? selectPluginFilterTemplates(sourceFiles) : sourceFiles;
      for (const file of supported) selected.set(file, path.join(templateDirectory, file));
      logger.dependency(`Found ${supported.length} supported bundled filter template(s) in ${templateDirectory}`);
    }
    return { selected, all };
  }

  /** Every template file in a folder, by shippedTemplateDigest. */
  private static async digestTemplates(files: Iterable<[string, string]>): Promise<Map<string, string>> {
    const digests = new Map<string, string>();
    for (const [file, filePath] of files) {
      try {
        digests.set(file, shippedTemplateDigest(await fs.readFile(filePath)));
      } catch (error) {
        logger.warn(`Could not read filter template ${file}:`, error);
      }
    }
    return digests;
  }

  private async templateState(bundledBasePath: string, ledger: InstallLedger): Promise<{
    state: TemplateState;
    selected: Map<string, string>;
  }> {
    const { selected, all } = await this.bundledTemplates(bundledBasePath);
    const installedFiles = await fs.pathExists(PATHS.FILTER_TEMPLATES)
      ? (await fs.readdir(PATHS.FILTER_TEMPLATES)).filter(f => f.endsWith('.vkfilter'))
      : [];

    return {
      selected,
      state: {
        bundled: await DependencyManager.digestTemplates(selected),
        shippedAnywhere: all,
        installed: await DependencyManager.digestTemplates(
          installedFiles.map(file => [file, path.join(PATHS.FILTER_TEMPLATES, file)]),
        ),
        ledger: ledger.templates,
        previousVersion: configManager.getAppVersion(),
      },
    };
  }

  /**
   * Seeds, updates and retires filter templates against the install ledger;
   * see templateReconcile.ts for the rules. What it does silently goes into
   * `report` when given one; what needs the user is left for the post-update
   * notice, which asks for it through getTemplateDecisions.
   */
  private async copyFilterTemplates(bundledBasePath: string, report?: UpdateReportDraft): Promise<void> {
    logger.dependency('Reconciling filter templates');
    await fs.ensureDir(PATHS.FILTER_TEMPLATES);

    // Targeted migrations from before the ledger, which match on the code
    // alone and so also catch a copy whose metadata alone was changed.
    const { selected: bundledSources } = await this.bundledTemplates(bundledBasePath);
    for (const [file, migrate] of [
      ['Crop.vkfilter', this.upgradeLegacyCropTemplate],
      ['Color Grade.vkfilter', this.upgradeSupersededGradeTemplate],
    ] as const) {
      const sourcePath = bundledSources.get(file);
      const destPath = path.join(PATHS.FILTER_TEMPLATES, file);
      if (sourcePath && await fs.pathExists(destPath) && await migrate.call(this, sourcePath, destPath)) {
        report?.templatesUpdated.push(file);
      }
    }
    await this.removeUnsupportedLinuxTemplates(bundledBasePath);
    await this.removeRetiredTemplates(report);

    const ledger = await readLedger();
    const { state, selected } = await this.templateState(bundledBasePath, ledger);
    // A missing bundle would read every installed template as dropped.
    if (selected.size === 0) {
      logger.warn('No bundled filter templates found; leaving installed templates alone');
      return;
    }

    const appVersion = app.getVersion();
    let decisions = 0;
    for (const action of planTemplateReconcile(state)) {
      const destPath = path.join(PATHS.FILTER_TEMPLATES, action.file);
      try {
        switch (action.kind) {
          case 'seed':
          case 'restore':
          case 'update':
            // A file we could not read reads as absent; it may still hold an
            // edit, so a seed or restore never writes over one that exists.
            if (action.kind !== 'update' && await fs.pathExists(destPath)) {
              logger.warn(`Filter template ${action.file} could not be read; leaving it as it is`);
              break;
            }
            await fs.copy(selected.get(action.file)!, destPath, { overwrite: true });
            ledger.templates[action.file] = { digest: state.bundled.get(action.file)!, appVersion };
            (action.kind === 'update' ? report?.templatesUpdated : report?.templatesAdded)?.push(action.file);
            if (action.kind === 'restore') {
              // Recorded as installed, gone, and not deleted in the app: some
              // other process removed it. Loud, so a log shows when it happens.
              logger.warn(`Filter template ${action.file} was missing without being deleted in the app; restored it`);
            } else {
              logger.dependency(`${action.kind === 'seed' ? 'Copied' : 'Updated unmodified'} filter template: ${action.file}`);
            }
            break;
          case 'remove':
            await fs.remove(destPath);
            delete ledger.templates[action.file];
            report?.templatesRemoved.push(action.file);
            logger.dependency(`Removed filter template no longer shipped: ${action.file}`);
            break;
          case 'record':
            ledger.templates[action.file] = { digest: action.digest, appVersion };
            break;
          case 'forget':
            delete ledger.templates[action.file];
            break;
          default:
            decisions++;
            logger.dependency(`Filter template needs a decision (${action.kind}): ${action.file}`);
        }
      } catch (error) {
        logger.warn(`Could not ${action.kind} filter template ${action.file}:`, error);
      }
    }

    await writeLedger(ledger);
    logger.dependency(`Filter templates reconciled${decisions > 0 ? `; ${decisions} edited template(s) need a decision` : ''}`);
  }

  /**
   * Version 2.0.0 briefly copied every Windows-authored plugin template to
   * Linux. Remove only unchanged bundled files from that release; a user
   * edit is deliberately kept as a custom template.
   */
  private async removeUnsupportedLinuxTemplates(bundledBasePath: string): Promise<void> {
    if (process.platform !== 'linux') return;
    const templateDirectory = path.join(bundledBasePath, 'include', 'plugins', 'plugin_filters');
    if (!await fs.pathExists(templateDirectory)) return;

    const sourceFiles = (await fs.readdir(templateDirectory)).filter(f => f.endsWith('.vkfilter'));
    for (const file of selectUnsupportedLinuxPluginFilterTemplates(sourceFiles)) {
      const sourcePath = path.join(templateDirectory, file);
      const destPath = path.join(PATHS.FILTER_TEMPLATES, file);
      if (!await fs.pathExists(destPath)) continue;

      // Any body the file has shipped with, line endings aside: a byte
      // comparison against this release's copy kept a CRLF or older copy
      // behind as a stray "custom" template.
      const [source, destination] = await Promise.all([
        fs.readFile(sourcePath),
        fs.readFile(destPath),
      ]);
      const digest = shippedTemplateDigest(destination);
      if (digest === shippedTemplateDigest(source) || SHIPPED_TEMPLATE_DIGESTS[file]?.includes(digest)) {
        await fs.remove(destPath);
        logger.dependency(`Removed unsupported Linux bundled filter template: ${file}`);
      }
    }
  }

  /**
   * Built-in filters the user deleted in the app: shipped for this platform,
   * marked deleted in the ledger, and not on disk. Launch never brings those
   * back, so this is the way to get them back.
   */
  async getMissingBundledTemplates(): Promise<string[]> {
    const { state } = await this.templateState(getBundledBasePath(), await readLedger());
    return [...state.bundled.keys()]
      .filter(file => !state.installed.has(file) && state.ledger[file]?.deletedByUser)
      .sort();
  }

  /** Puts back every built-in filter the install has deleted; answers the files restored. */
  async restoreMissingBundledTemplates(): Promise<string[]> {
    const missing = await this.getMissingBundledTemplates();
    if (missing.length === 0) return [];
    const ledger = await readLedger();
    for (const file of missing) delete ledger.templates[file];
    await writeLedger(ledger);
    // With no ledger entry and no file, the reconcile seeds them.
    await this.copyFilterTemplates(getBundledBasePath());
    logger.dependency(`Restored ${missing.length} built-in filter template(s): ${missing.join(', ')}`);
    return missing;
  }

  /** The edited templates the post-update notice asks about, with display names. */
  async getTemplateDecisions(): Promise<TemplateDecision[]> {
    const bundledBasePath = getBundledBasePath();
    const { state } = await this.templateState(bundledBasePath, await readLedger());
    if (state.bundled.size === 0) return [];

    const decisions: TemplateDecision[] = [];
    for (const action of planTemplateReconcile(state).filter(isDecision)) {
      decisions.push({
        file: action.file,
        name: await DependencyManager.templateName(path.join(PATHS.FILTER_TEMPLATES, action.file)) ?? action.file.replace(/\.vkfilter$/, ''),
        kind: action.kind,
        replacement: action.kind === 'edited-dropped' && action.replacement
          ? await DependencyManager.templateName(path.join(PATHS.FILTER_TEMPLATES, action.replacement)) ?? action.replacement.replace(/\.vkfilter$/, '')
          : undefined,
      });
    }
    return decisions;
  }

  private static async templateName(filePath: string): Promise<string | undefined> {
    try {
      const parsed = TOML.parse(await fs.readFile(filePath, 'utf-8')) as { name?: unknown };
      return typeof parsed.name === 'string' ? parsed.name : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Carries out the user's answer about one edited template. Anything that
   * would lose their copy backs it up first, to config/template-backups.
   */
  async resolveTemplateDecision(file: string, choice: 'replace' | 'keep' | 'remove'): Promise<{ backupPath?: string }> {
    if (path.basename(file) !== file || !file.endsWith('.vkfilter')) {
      throw new Error(`Not a filter template: ${file}`);
    }

    const bundledBasePath = getBundledBasePath();
    const ledger = await readLedger();
    const { state, selected } = await this.templateState(bundledBasePath, ledger);
    const action = planTemplateReconcile(state).find(candidate => candidate.file === file);
    if (!action || !isDecision(action)) {
      // Already settled, by an earlier click or an edit since the notice opened.
      return {};
    }

    const destPath = path.join(PATHS.FILTER_TEMPLATES, file);
    const appVersion = app.getVersion();
    const backup = async (): Promise<string> => {
      const backupDir = path.join(PATHS.CONFIG, 'template-backups', `before-${appVersion}`);
      await fs.ensureDir(backupDir);
      const backupPath = path.join(backupDir, file);
      await fs.copy(destPath, backupPath, { overwrite: true });
      return backupPath;
    };

    let backupPath: string | undefined;
    if (action.kind === 'edited-outdated' && choice === 'replace') {
      backupPath = await backup();
      await fs.copy(selected.get(file)!, destPath, { overwrite: true });
      ledger.templates[file] = { digest: state.bundled.get(file)!, appVersion };
    } else if (action.kind === 'edited-outdated' && choice === 'keep') {
      // Their edit now counts as based on this release's body, so it is asked
      // about again only when a later release changes it.
      ledger.templates[file] = { digest: state.bundled.get(file)!, appVersion };
    } else if (action.kind === 'edited-dropped' && choice === 'remove') {
      backupPath = await backup();
      await fs.remove(destPath);
      delete ledger.templates[file];
    } else if (action.kind === 'edited-dropped' && choice === 'keep') {
      ledger.templates[file] = { digest: state.installed.get(file)!, appVersion, keptDropped: true };
    } else {
      throw new Error(`Cannot ${choice} ${file}: ${action.kind}`);
    }

    await writeLedger(ledger);
    logger.dependency(`Filter template ${file}: ${choice}${backupPath ? ` (backup at ${backupPath})` : ''}`);
    return { backupPath };
  }

  /**
   * Templates a later release folded into another filter, with the sha256 of
   * every body ever shipped under that name.
   *
   * Nothing else removes a template a user already has: seeding only copies
   * what is absent, so a retired filter would sit in the list forever, doing
   * the same job as the one that replaced it. A user's own edit never matches
   * a shipped digest and is kept, becoming a custom template.
   *
   * Chains are unaffected either way — a saved step carries its own copy of the
   * code, so one built on a retired template keeps working untouched.
   */
  private static readonly RETIRED_TEMPLATES: ReadonlyArray<{
    file: string;
    shipped: ReadonlySet<string>;
    reason: string;
  }> = [
    {
      file: 'Crop _auto_.vkfilter',
      // The only body it ever had, from the release that split it out of Crop.
      shipped: new Set(['ba5a851bbdc067320b1217b9750684834be3e8c01efb98af4279a28462ca863e']),
      reason: 'Crop removes Pad and Modulus padding again when every edge is 0',
    },
  ];

  private async removeRetiredTemplates(report?: UpdateReportDraft): Promise<void> {
    for (const retired of DependencyManager.RETIRED_TEMPLATES) {
      const destPath = path.join(PATHS.FILTER_TEMPLATES, retired.file);
      try {
        if (!await fs.pathExists(destPath)) continue;

        const template = TOML.parse(await fs.readFile(destPath, 'utf-8')) as { code?: string };
        if (!template.code) continue;

        const code = template.code.replace(/\r\n?/g, '\n').trim();
        const digest = crypto.createHash('sha256').update(code).digest('hex');
        if (!retired.shipped.has(digest)) continue;

        await fs.remove(destPath);
        report?.templatesRemoved.push(retired.file);
        logger.dependency(`Removed the retired ${retired.file} template: ${retired.reason}`);
      } catch (error) {
        logger.warn(`Could not inspect ${retired.file} for retirement:`, error);
      }
    }
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
    await this.copyFilterTemplates(bundledBasePath);
    
    // Create FFmpeg settings JSON if it doesn't exist
    const ffmpegConfigPath = path.join(PATHS.CONFIG, 'ffmpeg_settings.json');
    if (!await fs.pathExists(ffmpegConfigPath)) {
      const defaultConfig = {
        "_comment": "Edit these args to customize FFmpeg encoding. These are passed directly to FFmpeg.",
        "args": [
          "-c:v", "libx264",
          "-preset", "medium",
          "-crf", "18"
        ]
      };
      await fs.writeJson(ffmpegConfigPath, defaultConfig, { spaces: 2 });
      logger.dependency('Created user FFmpeg settings');
    }
    
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
