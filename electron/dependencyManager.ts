import * as path from 'path';
import * as fs from 'fs-extra';
import axios from 'axios';
import { app, BrowserWindow} from 'electron';
import { ModelExtractor } from './modelExtractor';
import { logger } from './logger';
import { PATHS, VS_MLRT_VERSION } from './constants';
import { runCommand, getBundledBasePath } from './utils';
import { FFmpegManager } from './ffmpegManager';
import { configManager } from './configManager';
import { VsMlrtManager } from './vsMlrtManager';
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
    logger.dependency('Setting up embedded Python');
    
    this.sendProgress({
      type: 'python-setup',
      component: 'Python Embedded',
      progress: 0,
      message: 'Setting up embedded Python for VapourSynth...'
    });

    // Check if Python is already set up
    if (await fs.pathExists(PATHS.PYTHON)) {
      logger.dependency(`Embedded Python already exists at: ${PATHS.PYTHON}`);
      this.sendProgress({
        type: 'python-setup',
        component: 'Python Embedded',
        progress: 100,
        message: 'Embedded Python already configured'
      });
      return;
    }

    this.sendProgress({
      type: 'python-setup',
      component: 'Python Embedded',
      progress: 10,
      message: 'Downloading Python 3.13 embedded...'
    });

    // Determine latest Python 3.13.x version
    const pythonVersion = '3.13.0';
    const pythonZipPath = path.join(PATHS.APP_DATA, `python-${pythonVersion}-embed-amd64.zip`);
    logger.dependency(`Downloading Python ${pythonVersion}`);
    
    await this.downloadFile(
      `https://www.python.org/ftp/python/${pythonVersion}/python-${pythonVersion}-embed-amd64.zip`,
      pythonZipPath,
      'Python 3.13 Embedded'
    );

    this.sendProgress({
      type: 'python-setup',
      component: 'Python Embedded',
      progress: 40,
      message: 'Extracting Python to VapourSynth folder...'
    });

    // Extract Python to VapourSynth folder
    await this.extractArchive(pythonZipPath, PATHS.VS, 'Python 3.13 Embedded');
    await fs.remove(pythonZipPath);
    logger.dependency('Python extracted successfully');

    this.sendProgress({
      type: 'python-setup',
      component: 'Python Embedded',
      progress: 50,
      message: 'Configuring Python paths...'
    });

    // Modify python313._pth to add import paths
    const pthFilePath = path.join(PATHS.VS, 'python313._pth');
    await fs.appendFile(pthFilePath, '\nvs-scripts\nLib\\site-packages\n', 'utf8');
    logger.dependency('Python paths configured');

    // Create required directories
    await fs.ensureDir(PATHS.PLUGINS);
    await fs.ensureDir(path.join(PATHS.VS, 'vs-scripts'));

    this.sendProgress({
      type: 'python-setup',
      component: 'Python Embedded',
      progress: 60,
      message: 'Downloading pip installer...'
    });

    // Download get-pip.py
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

    // Install pip
    logger.dependency('Installing pip');
    await runCommand(PATHS.PYTHON, [getPipPath, '--no-warn-script-location'], PATHS.APP_DATA);
    await fs.remove(getPipPath);

    // Remove Scripts/*.exe as per the original script
    const scriptsPath = path.join(PATHS.VS, 'Scripts');
    if (await fs.pathExists(scriptsPath)) {
      const exeFiles = (await fs.readdir(scriptsPath)).filter(f => f.endsWith('.exe'));
      for (const exeFile of exeFiles) {
        await fs.remove(path.join(scriptsPath, exeFile));
      }
      logger.dependency(`Removed ${exeFiles.length} .exe files from Scripts folder`);
    }

    this.sendProgress({
      type: 'python-setup',
      component: 'Python Embedded',
      progress: 80,
      message: 'Handling VSScript DLL...'
    });

    // Handle VSScript DLL (for Python 3.13, we remove the Python 3.8 version)
    const vsScriptPy38 = path.join(PATHS.VS, 'VSScriptPython38.dll');
    if (await fs.pathExists(vsScriptPy38)) {
      await fs.remove(vsScriptPy38);
      logger.dependency('Removed VSScriptPython38.dll');
    }

    this.sendProgress({
      type: 'python-setup',
      component: 'Python Embedded',
      progress: 90,
      message: 'Installing VapourSynth Python package...'
    });

    // Try to install VapourSynth wheel if it exists locally
    const wheelPath = path.join(PATHS.VS, 'wheel', 'VapourSynth-72-cp312-abi3-win_amd64.whl');
    if (await fs.pathExists(wheelPath)) {
      logger.dependency('Installing VapourSynth from local wheel');
      await runCommand(PATHS.PYTHON, ['-m', 'pip', 'install', wheelPath]);
    } else {
      // Install VapourSynth from PyPI if local wheel doesn't exist.
      // Pin to match the bundled VapourSynth runtime — newer Python package
      // versions are not ABI-compatible with older VapourSynth installs.
      logger.dependency('Installing VapourSynth from PyPI');
      await runCommand(PATHS.PYTHON, ['-m', 'pip', 'install', 'vapoursynth==72']);
    }

    // Install vstools (required by several vkfilters that import from vstools).
    // vstools declares `Requires-Dist: vsjetpack` with no version pin — pip would
    // resolve to the latest vsjetpack (1.5.0+), which requires vapoursynth>=73 and
    // would silently upgrade the Python package away from the bundled R72 runtime,
    // breaking VSScript initialization. Pin vsjetpack to a vapoursynth>=69 release
    // and re-assert vapoursynth==72 to make pip's resolver refuse any upgrade.
    logger.dependency('Installing vstools');
    await runCommand(PATHS.PYTHON, [
      '-m', 'pip', 'install',
      'vstools',
      'vsjetpack==1.1.0',
      'vapoursynth==72',
      '--no-warn-script-location',
    ]);

    this.sendProgress({
      type: 'python-setup',
      component: 'Python Embedded',
      progress: 100,
      message: 'Embedded Python configured successfully'
    });

    logger.dependency('Embedded Python setup completed');
  }

  async checkDependencies(): Promise<boolean> {
    logger.dependency('Checking dependencies');
    
    // Import CUDA detection
    const { detectCudaSupport } = await import('./utils');
    const hasCuda = await detectCudaSupport();
    
    const vsExists = await fs.pathExists(PATHS.VSPIPE);
    const mlrtExists = hasCuda ? await fs.pathExists(path.join(PATHS.MLRT_PLUGIN, 'trtexec.exe')) : true; // Skip if no CUDA
    const ortExists = await fs.pathExists(path.join(PATHS.PLUGINS, 'vsort.dll'));
    const bsExists = await fs.pathExists(path.join(PATHS.PLUGINS, 'bestsource.dll'));
    const pythonExists = await fs.pathExists(PATHS.PYTHON);
    const videoCompareExists = await fs.pathExists(PATHS.VIDEO_COMPARE_EXE);
    const ffmpegExists = await FFmpegManager.isInstalled();
    // NOTE: No longer checking if models are converted - they will be initialized on-demand
    
    logger.dependency(`CUDA support: ${hasCuda}`);
    logger.dependency(`VapourSynth: ${vsExists}`);
    logger.dependency(`MLRT Plugin: ${mlrtExists} ${hasCuda ? '' : '(skipped - no CUDA)'}`);
    logger.dependency(`ONNX Runtime Plugin: ${ortExists}`);
    logger.dependency(`BestSource: ${bsExists}`);
    logger.dependency(`Python: ${pythonExists}`);
    logger.dependency(`Video Compare: ${videoCompareExists}`);
    logger.dependency(`FFmpeg: ${ffmpegExists}`);

    const coreDepsPresent = vsExists && mlrtExists && ortExists && bsExists && pythonExists && videoCompareExists && ffmpegExists;

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
      // Detect CUDA support first
      const { detectCudaSupport } = await import('./utils');
      const hasCuda = await detectCudaSupport();
      logger.dependency(`=== CUDA DETECTION RESULT: ${hasCuda} ===`);
      logger.dependency(`Will ${hasCuda ? 'DOWNLOAD' : 'SKIP'} TensorRT plugin`);
      
      // Component configurations (non-vs-mlrt components)
      const components: ComponentConfig[] = [
        {
          name: 'VapourSynth R72',
          url: 'https://github.com/vapoursynth/vapoursynth/releases/download/R72/VapourSynth64-Portable-R72.zip',
          archiveName: 'vs-portable.zip',
          checkPath: PATHS.VSPIPE,
          extractTo: PATHS.VS
        },
        {
          name: 'BestSource R13',
          url: 'https://github.com/vapoursynth/bestsource/releases/download/R13/BestSource-R13.7z',
          archiveName: 'bestsource.7z',
          checkPath: path.join(PATHS.PLUGINS, 'bestsource.dll'),
          extractTo: PATHS.PLUGINS
        },
        {
          name: 'Video Compare Tool',
          url: 'https://github.com/pixop/video-compare/releases/download/20250928/video-compare-20250928-win10-x86_64.zip',
          archiveName: 'video-compare.zip',
          checkPath: PATHS.VIDEO_COMPARE_EXE,
          extractTo: PATHS.VIDEO_COMPARE
        }
      ];

      // Check for vs-mlrt version change before installation
      const storedVsMlrtVersion = configManager.getVsMlrtVersion();
      const hasVsMlrtVersionChange = storedVsMlrtVersion && storedVsMlrtVersion !== VS_MLRT_VERSION;
      
      if (hasCuda && hasVsMlrtVersionChange) {
        logger.dependency(`=== vs-mlrt VERSION CHANGE DETECTED: ${storedVsMlrtVersion} → ${VS_MLRT_VERSION} ===`);
        logger.dependency('User will be notified to rebuild TensorRT engines');
      }

      // Install standard components
      for (const component of components) {
        await this.downloadAndInstallComponent(component);
      }

      // Install vs-mlrt components using the unified manager
      // ONNX Runtime (always needed)
      if (!(await VsMlrtManager.isComponentInstalled('onnx-runtime'))) {
        logger.dependency('Installing vs-mlrt ONNX Runtime');
        await VsMlrtManager.downloadAndInstall('onnx-runtime', (progress) => {
          this.sendProgress({
            type: 'download',
            component: VsMlrtManager.getComponentName('onnx-runtime'),
            progress: progress.progress,
            message: progress.message
          });
        });
      } else {
        logger.dependency('vs-mlrt ONNX Runtime already installed');
      }

      // TensorRT (only if CUDA is available)
      if (hasCuda) {
        logger.dependency('=== CUDA DETECTED - Installing TensorRT plugin ===');
        
        // CRITICAL: Do NOT auto-update TensorRT if version changed and it's already installed
        // This allows the user to be notified via modal and decide when to update
        const isTensorRtInstalled = await VsMlrtManager.isComponentInstalled('tensorrt');
        
        if (hasVsMlrtVersionChange && isTensorRtInstalled) {
          logger.dependency('TensorRT already installed with different version - skipping auto-update (user will be notified)');
        } else if (!isTensorRtInstalled) {
          await VsMlrtManager.downloadAndInstall('tensorrt', (progress) => {
            this.sendProgress({
              type: 'download',
              component: VsMlrtManager.getComponentName('tensorrt'),
              progress: progress.progress,
              message: progress.message
            });
          });
        } else {
          logger.dependency('vs-mlrt TensorRT already installed');
        }
      } else {
        logger.dependency('=== NO CUDA DETECTED - Skipping TensorRT plugin ===');
      }

      // Note: We intentionally do NOT update the stored vs-mlrt version here.
      // The version check in the frontend (App.tsx) will detect the mismatch and
      // show a notification modal if there are existing engine files that need rebuilding.
      // The version is only updated after the user acknowledges the notification or
      // clears their engines, ensuring they are informed of the change.
      
      // Setup embedded Python
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

      // Install FFmpeg if not present
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

  private async extractExtraPlugins(): Promise<void> {
    logger.dependency('Checking for extra plugins');
    
    // Get bundled extra plugins path
    const bundledBasePath = getBundledBasePath();
    const extraPluginsPath = path.join(bundledBasePath, 'include', 'plugins', 'extra_plugins.7z');
    
    if (await fs.pathExists(extraPluginsPath)) {
      logger.dependency(`Found extra plugins at: ${extraPluginsPath}`);
      
      this.sendProgress({
        type: 'extract',
        component: 'Extra Plugins',
        progress: 0,
        message: 'Extracting extra VapourSynth plugins...'
      });
      
      try {
        await this.extractArchive(extraPluginsPath, PATHS.PLUGINS, 'Extra Plugins');
        logger.dependency('Extra plugins extracted successfully');
      } catch (error) {
        logger.error('Failed to extract extra plugins:', error);
        // Don't fail the entire setup if extra plugins fail
      }
    } else {
      logger.dependency('No extra plugins found, skipping');
    }
  }
}