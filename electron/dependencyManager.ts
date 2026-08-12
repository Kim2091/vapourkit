import * as path from 'path';
import * as fs from 'fs-extra';
import axios from 'axios';
import { app, BrowserWindow} from 'electron';
import { ModelExtractor } from './modelExtractor';
import { VsMlrtModelsManager } from './vsMlrtModelsManager';
import { ensureTrtexecShim } from './trtexecShim';
import { logger } from './logger';
import { PATHS, PYTHON_VERSION, IS_WINDOWS } from './constants';
import { runCommand, getBundledBasePath, isSupportedPython } from './utils';
import { FFmpegManager } from './ffmpegManager';
import { configManager } from './configManager';
import { migrateLegacyPortableLayout } from './legacyCleanup';
import * as _7z from '7zip-min';

export interface DownloadProgress {
  type: 'download' | 'extract' | 'complete' | 'error' | 'python-setup' | 'model-extract';
  component: string;
  progress: number;
  message: string;
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

    if (!await fs.pathExists(PATHS.PYTHON)) {
      if (!IS_WINDOWS) {
        this.sendProgress({
          type: 'python-setup',
          component: 'Python Embedded',
          progress: 10,
          message: 'Creating a Python 3 virtual environment...'
        });
        if (!await isSupportedPython('python3')) {
          throw new Error('Python 3.12 or 3.13 with venv support is required on Linux. Install a supported python3 and python3-venv with your distribution package manager, then restart Vapourkit.');
        }
        await runCommand('python3', ['-m', 'venv', PATHS.VS], PATHS.APP_DATA);
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

    // Install pip if missing
    if (!await fs.pathExists(path.join(PATHS.SITE_PACKAGES, 'pip'))) {
      this.sendProgress({
        type: 'python-setup',
        component: 'Python Embedded',
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
        component: 'Python Embedded',
        progress: 70,
        message: 'Installing pip...'
      });

      logger.dependency('Installing pip');
      await runCommand(PATHS.PYTHON, [getPipPath, '--no-warn-script-location'], PATHS.APP_DATA);
      await fs.remove(getPipPath);
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
      'vapoursynth',
      'vapoursynth-bestsource',
    ]);

    this.sendProgress({
      type: 'python-setup',
      component: 'Python Embedded',
      progress: 100,
      message: 'Python runtime configured successfully'
    });

    logger.dependency('Python runtime setup completed');
  }

  async checkDependencies(): Promise<boolean> {
    logger.dependency('Checking dependencies');

    // vspipe.exe ships inside the VapourSynth wheel (site-packages/vapoursynth),
    // BestSource inside the vapoursynth-bestsource wheel. Old zip-based installs
    // fail these checks and get migrated by re-running setup.
    const vsExists = await fs.pathExists(PATHS.VSPIPE);
    const bsExists = await fs.pathExists(PATHS.BESTSOURCE_DLL);
    const pythonExists = await fs.pathExists(PATHS.PYTHON);
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

    // Detect app version change (upgrade-in-place) and update bundled files
    if (coreDepsPresent) {
      const currentVersion = app.getVersion();
      const storedVersion = configManager.getAppVersion();
      if (storedVersion !== currentVersion) {
        logger.dependency(`App version changed: ${storedVersion || 'none'} → ${currentVersion} — updating bundled files`);
        try {
          await this.updateBundledFiles();
          await configManager.setAppVersion(currentVersion);
          logger.dependency('Bundled files updated for new version');
        } catch (updateError) {
          logger.error('Failed to update bundled files on version change:', updateError);
          // Non-fatal: don't block startup
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
    
    await fs.ensureDir(path.dirname(outputPath));
    
    const response = await axios({
      url,
      method: 'GET',
      responseType: 'stream',
      onDownloadProgress: (progressEvent) => {
        const percentCompleted = progressEvent.total 
          ? Math.round((progressEvent.loaded * 100) / progressEvent.total)
          : 0;
        
        this.sendProgress({
          type: 'download',
          component: componentName,
          progress: percentCompleted,
          message: `Downloading ${componentName}... ${percentCompleted}%`
        });
      }
    });

    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        logger.dependency(`Download completed: ${componentName}`);
        resolve();
      });
      writer.on('error', (error) => {
        logger.error(`Download failed for ${componentName}:`, error);
        reject(error);
      });
    });
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
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Dependency setup failed:', errorMsg);
      
      this.sendProgress({
        type: 'error',
        component: 'Setup',
        progress: 0,
        message: `Setup failed: ${errorMsg}`
      });
      throw error;
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
  private async updateBundledFiles(): Promise<void> {
    const bundledBasePath = getBundledBasePath();

    // Always overwrite VapourSynth template — it's a placeholder-driven generated script,
    // not user-customizable, and must match the current script generator.
    const bundledTemplatePath = path.join(bundledBasePath, 'include', 'vapoursynth_template.vpy');
    const userTemplatePath = path.join(PATHS.CONFIG, 'vapoursynth_template.vpy');
    if (await fs.pathExists(bundledTemplatePath)) {
      await fs.copy(bundledTemplatePath, userTemplatePath, { overwrite: true });
      logger.dependency('Updated VapourSynth template from bundled source');
    }

    // Copy any new filter templates (existing ones are preserved)
    await this.copyFilterTemplates(bundledBasePath);
  }

  private async copyTemplateIfNeeded(userPath: string, bundledPath: string, logName: string): Promise<void> {
    if (!await fs.pathExists(userPath)) {
      if (await fs.pathExists(bundledPath)) {
        await fs.copy(bundledPath, userPath);
        logger.dependency(`Created user ${logName}`);
      }
    }
  }

  private async copyFilterTemplates(bundledBasePath: string): Promise<void> {
    logger.dependency('Copying filter templates');
    
    // Ensure filter templates directory exists
    await fs.ensureDir(PATHS.FILTER_TEMPLATES);
    
    // Path to bundled filter templates
    const bundledTemplatesPath = path.join(bundledBasePath, 'include', 'filter_templates');
    
    // Check if bundled templates directory exists
    if (!await fs.pathExists(bundledTemplatesPath)) {
      logger.warn(`Bundled filter templates not found at: ${bundledTemplatesPath}`);
      return;
    }
    
    // Get all vkfilter files from bundled templates
    const files = await fs.readdir(bundledTemplatesPath);
    const vkfilterFiles = files.filter(f => f.endsWith('.vkfilter'));
    
    logger.dependency(`Found ${vkfilterFiles.length} bundled filter template(s)`);
    
    // Copy each template if it doesn't exist in user directory
    for (const file of vkfilterFiles) {
      const sourcePath = path.join(bundledTemplatesPath, file);
      const destPath = path.join(PATHS.FILTER_TEMPLATES, file);
      
      if (!await fs.pathExists(destPath)) {
        await fs.copy(sourcePath, destPath);
        logger.dependency(`Copied filter template: ${file}`);
      } else {
        logger.dependency(`Filter template already exists: ${file}`);
      }
    }
    
    logger.dependency('Filter templates copied');
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
    
    // Always overwrite VapourSynth template from bundled source.
    // This is a generated-script template with placeholders, not a user-customizable file,
    // so it must stay in sync with the current app version to avoid runtime errors
    // (e.g. missing imports like set_output).
    const userTemplatePath = path.join(PATHS.CONFIG, 'vapoursynth_template.vpy');
    const bundledTemplatePath = path.join(bundledBasePath, 'include', 'vapoursynth_template.vpy');
    if (await fs.pathExists(bundledTemplatePath)) {
      await fs.copy(bundledTemplatePath, userTemplatePath, { overwrite: true });
      logger.dependency('Updated VapourSynth template from bundled source');
    }
    
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
  }

  getPythonExecutablePath(): string {
    return PATHS.PYTHON;
  }
}
