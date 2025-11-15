// electron/pluginInstaller.ts
import { spawn, ChildProcess } from 'child_process';
import { BrowserWindow, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs-extra';
import { logger } from './logger';
import { PATHS } from './constants';
import { configManager } from './configManager';

// Fix 7zip-bin path for ASAR BEFORE importing 7zip-min
const sevenBin = require('7zip-bin');
if (sevenBin.path7za.includes('app.asar') && !sevenBin.path7za.includes('app.asar.unpacked')) {
  sevenBin.path7za = sevenBin.path7za.replace('app.asar', 'app.asar.unpacked');
  logger.info(`Fixed 7zip path to: ${sevenBin.path7za}`);
}
import * as _7z from '7zip-min';

export interface PluginDependencyProgress {
  type: 'installing' | 'complete' | 'error';
  progress: number;
  message: string;
}

export class PluginInstaller {
  private mainWindow: BrowserWindow | null;
  private installProcess: ChildProcess | null = null;
  private isCancelled: boolean = false;

  constructor(mainWindow: BrowserWindow | null = null) {
    this.mainWindow = mainWindow;
  }

  private sendProgress(progress: PluginDependencyProgress) {
    if (this.mainWindow) {
      this.mainWindow.webContents.send('plugin-dependency-progress', progress);
    }
  }

  private async runPipInstall(
    packages: string[],
    progressOffset: number,
    progressScale: number,
    extraArgs: string[] = []
  ): Promise<{ success: boolean; error?: string }> {
    const args = ['-m', 'pip', 'install', '--no-warn-script-location', ...packages, ...extraArgs];
    
    const commandStr = `${PATHS.PYTHON} ${args.join(' ')}`;
    logger.info(`Running command: ${commandStr}`);

    return new Promise((resolve) => {
      this.installProcess = spawn(PATHS.PYTHON, args, {
        cwd: PATHS.VS,
        windowsHide: true
      });

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

  async installDependencies(): Promise<{ success: boolean; error?: string }> {
    logger.info('Starting plugin dependency installation');
    this.isCancelled = false;

    try {
      this.sendProgress({
        type: 'installing',
        progress: 0,
        message: 'Preparing to install PyTorch, torchvision, numpy, and positional_encodings...'
      });

      logger.info('Starting plugin dependency installation...');
      
      // Step 0: Ensure setuptools and wheel are installed (0-5% progress)
      logger.info('=== Step 0: Ensuring setuptools and wheel are installed ===');
      const setupResult = await this.runPipInstall(
        ['setuptools', 'wheel'],
        0,
        5,
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

      logger.info('=== Step 1: Installing PyTorch and torchvision ===');
      const pytorchResult = await this.runPipInstall(
        ['torch', 'torchvision'],
        5,
        65,
        ['--index-url', 'https://download.pytorch.org/whl/cu130']
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

      // Step 2: Install numpy, positional-encodings, einops, timm, and vsjetpack (70-85% progress)
      logger.info('=== Step 2: Installing numpy, positional-encodings, einops, timm, and vsjetpack ===');
      const additionalResult = await this.runPipInstall(
        ['numpy==2.3.3', 'positional-encodings', 'einops', 'timm', 'vsjetpack'],
        70,
        15
      );

      if (!additionalResult.success) {
        this.sendProgress({
          type: 'error',
          progress: 0,
          message: additionalResult.error || 'Additional packages installation failed'
        });
        return { success: false, error: additionalResult.error };
      }

      if (this.isCancelled) {
        return { success: false, error: 'Installation cancelled by user' };
      }

      // Step 3: Extract all plugins from plugins folder (85-90% progress)
      logger.info('=== Step 3: Extracting plugins from plugins folder ===');
      await this.extractAllPlugins();

      if (this.isCancelled) {
        return { success: false, error: 'Installation cancelled by user' };
      }

      // Step 4: Extract all scripts from scripts folder (90-95% progress)
      logger.info('=== Step 4: Extracting scripts from scripts folder ===');
      await this.extractAllScripts();

      if (this.isCancelled) {
        return { success: false, error: 'Installation cancelled by user' };
      }

      // Step 5: Copy filter templates (95-100% progress)
      logger.info('=== Step 5: Copying filter templates ===');
      await this.copyFilterTemplates();

      // Step 6: Reload backend to refresh models and configs
      logger.info('=== Step 6: Reloading backend ===');
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

  async checkInstalled(): Promise<{ installed: boolean; packages: string[] }> {
    logger.info('Checking if plugin dependencies are installed');
    
    const packagesToCheck = ['torch', 'torchvision', 'numpy', 'positional-encodings', 'einops', 'timm', 'vsjetpack'];
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
            const installedPackages = JSON.parse(outputBuffer);
            const installedNames = installedPackages.map((pkg: any) => pkg.name.toLowerCase());
            
            const foundPackages = packagesToCheck.filter(pkg => 
              installedNames.includes(pkg.toLowerCase())
            );
            
            const allInstalled = foundPackages.length === packagesToCheck.length;
            logger.info(`Dependencies check: ${allInstalled ? 'all installed' : 'missing some'} (${foundPackages.length}/${packagesToCheck.length})`);
            
            resolve({ installed: allInstalled, packages: foundPackages });
          } catch (error) {
            logger.error('Error parsing pip list output:', error);
            logger.error('Output buffer:', outputBuffer);
            resolve({ installed: false, packages: [] });
          }
        } else {
          logger.error(`Failed to check installed packages (exit code: ${code})`);
          if (errorBuffer.trim()) {
            logger.error('Error output:', errorBuffer);
          }
          if (outputBuffer.trim()) {
            logger.error('Standard output:', outputBuffer);
          }
          resolve({ installed: false, packages: [] });
        }
      });

      checkProcess.on('error', (error: Error) => {
        logger.error('Failed to run pip list:', error);
        logger.error('Python path:', PATHS.PYTHON);
        logger.error('VS path:', PATHS.VS);
        resolve({ installed: false, packages: [] });
      });
    });
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

      const packagesToUninstall = ['torch', 'torchvision', 'numpy', 'positional-encodings', 'einops', 'timm', 'vsjetpack'];
      const args = ['-m', 'pip', 'uninstall', '-y', ...packagesToUninstall];
      
      const commandStr = `${PATHS.PYTHON} ${args.join(' ')}`;
      logger.info(`Running command: ${commandStr}`);

      return new Promise((resolve) => {
        this.installProcess = spawn(PATHS.PYTHON, args, {
          cwd: PATHS.VS,
          windowsHide: true
        });

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

  cancel(): void {
    if (this.installProcess) {
      logger.info('Cancelling plugin dependency operation');
      this.isCancelled = true;
      this.installProcess.kill();
      this.installProcess = null;
    }
  }

  private async extractAllPlugins(): Promise<void> {
    logger.info('Extracting all plugins from plugins folder');
    
    // Get bundled plugins path (handle ASAR unpacking)
    const appPath = app.getAppPath();
    let bundledBasePath: string;
    
    if (appPath.includes('.asar')) {
      // In production with ASAR, plugins are unpacked
      bundledBasePath = appPath.replace('app.asar', 'app.asar.unpacked');
    } else {
      // In development or non-ASAR build
      bundledBasePath = appPath;
    }
    
    const pluginsFolder = path.join(bundledBasePath, 'include', 'plugins');
    
    if (!await fs.pathExists(pluginsFolder)) {
      logger.info('No plugins folder found, skipping plugin extraction');
      return;
    }

    this.sendProgress({
      type: 'installing',
      progress: 85,
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
      const progress = 85 + Math.floor((i / archiveFiles.length) * 5);
      
      logger.info(`Extracting ${archiveFile} (${i + 1}/${archiveFiles.length})`);
      
      this.sendProgress({
        type: 'installing',
        progress,
        message: `Extracting ${archiveFile}...`
      });

      try {
        await this.extractArchive(archivePath, PATHS.PLUGINS, archiveFile);
        logger.info(`Successfully extracted ${archiveFile}`);
      } catch (error) {
        logger.error(`Failed to extract ${archiveFile}:`, error);
        // Continue with other plugins even if one fails
      }
    }
    
    logger.info('Plugin extraction completed');
  }

  private async extractAllScripts(): Promise<void> {
    logger.info('Extracting all scripts from scripts folder');
    
    // Get bundled scripts path (handle ASAR unpacking)
    const appPath = app.getAppPath();
    let bundledBasePath: string;
    
    if (appPath.includes('.asar')) {
      // In production with ASAR, scripts are unpacked
      bundledBasePath = appPath.replace('app.asar', 'app.asar.unpacked');
    } else {
      // In development or non-ASAR build
      bundledBasePath = appPath;
    }
    
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

  private async extractArchive(archivePath: string, outputPath: string, componentName: string): Promise<void> {
    logger.info(`Extracting ${componentName} from ${archivePath} to ${outputPath}`);
    await fs.ensureDir(outputPath);

    try {
      await _7z.unpack(archivePath, outputPath);
      logger.info(`Extraction completed: ${componentName}`);
    } catch (err: any) {
      const errorMsg = `Error extracting ${componentName}: ${err.message}`;
      logger.error(errorMsg);
      throw err;
    }
  }

  private async copyFilterTemplates(): Promise<void> {
    logger.info('Copying filter templates from plugin_filters folder');
    
    // Get bundled plugin_filters path (handle ASAR unpacking)
    const appPath = app.getAppPath();
    let bundledBasePath: string;
    
    if (appPath.includes('.asar')) {
      // In production with ASAR, plugins are unpacked
      bundledBasePath = appPath.replace('app.asar', 'app.asar.unpacked');
    } else {
      // In development or non-ASAR build
      bundledBasePath = appPath;
    }
    
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