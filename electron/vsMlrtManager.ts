// electron/vsMlrtManager.ts
import * as path from 'path';
import * as fs from 'fs-extra';
import axios from 'axios';
import { BrowserWindow } from 'electron';
import { PATHS, VS_MLRT_VERSION } from './constants';
import { logger } from './logger';
import * as _7z from '7zip-min';

export type VsMlrtComponent = 'onnx-runtime' | 'tensorrt';

export interface VsMlrtDownloadProgress {
  progress: number;
  message: string;
}

export type VsMlrtProgressCallback = (progress: VsMlrtDownloadProgress) => void;

export class VsMlrtManager {
  /**
   * Get the download URL for a specific vs-mlrt component
   */
  static getComponentUrl(component: VsMlrtComponent): string {
    const baseUrl = `https://github.com/AmusementClub/vs-mlrt/releases/download/v${VS_MLRT_VERSION}`;
    
    switch (component) {
      case 'onnx-runtime':
        return `${baseUrl}/VSORT-Windows-x64.v${VS_MLRT_VERSION}.7z`;
      case 'tensorrt':
        return `${baseUrl}/vsmlrt-windows-x64-tensorrt.v${VS_MLRT_VERSION}.7z`;
    }
  }

  /**
   * Get the component name for display purposes
   */
  static getComponentName(component: VsMlrtComponent): string {
    switch (component) {
      case 'onnx-runtime':
        return `vs-mlrt ONNX Runtime v${VS_MLRT_VERSION}`;
      case 'tensorrt':
        return `vs-mlrt TensorRT v${VS_MLRT_VERSION}`;
    }
  }

  /**
   * Get the archive name for a component
   */
  static getArchiveName(component: VsMlrtComponent): string {
    switch (component) {
      case 'onnx-runtime':
        return 'vsort.7z';
      case 'tensorrt':
        return 'vsmlrt.7z';
    }
  }

  /**
   * Get the check path to verify if a component is installed
   */
  static getCheckPath(component: VsMlrtComponent): string {
    switch (component) {
      case 'onnx-runtime':
        return path.join(PATHS.PLUGINS, 'vsort.dll');
      case 'tensorrt':
        return path.join(PATHS.MLRT_PLUGIN, 'trtexec.exe');
    }
  }

  /**
   * Check if a component is installed
   */
  static async isComponentInstalled(component: VsMlrtComponent): Promise<boolean> {
    return await fs.pathExists(VsMlrtManager.getCheckPath(component));
  }

  /**
   * Download and install a vs-mlrt component
   */
  static async downloadAndInstall(
    component: VsMlrtComponent,
    progressCallback?: VsMlrtProgressCallback
  ): Promise<void> {
    const componentName = VsMlrtManager.getComponentName(component);
    const url = VsMlrtManager.getComponentUrl(component);
    const archiveName = VsMlrtManager.getArchiveName(component);
    const archivePath = path.join(PATHS.APP_DATA, archiveName);

    try {
      logger.info(`=== Downloading ${componentName} ===`);
      progressCallback?.({ progress: 5, message: `Preparing to download ${componentName}...` });

      // Download the archive
      logger.info(`Download URL: ${url}`);
      progressCallback?.({ progress: 10, message: `Downloading ${componentName}...` });

      const response = await axios({
        method: 'get',
        url,
        responseType: 'stream',
        timeout: 300000 // 5 minutes
      });

      const writer = fs.createWriteStream(archivePath);
      const contentLength = response.headers['content-length'];
      const totalLength = typeof contentLength === 'string' ? parseInt(contentLength, 10) : 0;
      let downloadedLength = 0;

      response.data.on('data', (chunk: Buffer) => {
        downloadedLength += chunk.length;
        const downloadProgress = totalLength > 0 ? (downloadedLength / totalLength) * 70 : 0;
        const percentComplete = totalLength > 0 ? Math.round((downloadedLength / totalLength) * 100) : 0;
        progressCallback?.({
          progress: 10 + downloadProgress,
          message: `Downloading: ${percentComplete}%`
        });
      });

      await new Promise<void>((resolve, reject) => {
        response.data.pipe(writer);
        writer.on('finish', () => resolve());
        writer.on('error', reject);
      });

      logger.info(`Downloaded to: ${archivePath}`);

      // Extract the archive
      progressCallback?.({ progress: 80, message: `Extracting ${componentName}...` });
      logger.info(`Extracting to: ${PATHS.PLUGINS}`);

      // For TensorRT, remove old plugin directory first
      if (component === 'tensorrt') {
        const mlrtPluginPath = path.join(PATHS.PLUGINS, 'vsmlrt-cuda');
        if (await fs.pathExists(mlrtPluginPath)) {
          logger.info('Removing old vs-mlrt TensorRT plugin directory');
          await fs.remove(mlrtPluginPath);
        }
      }

      // Retry logic for file locking issues on Windows
      const maxRetries = 5;
      const retryDelay = 2000; // 2 seconds
      let lastError: any = null;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await new Promise<void>((resolve, reject) => {
            _7z.unpack(archivePath, PATHS.PLUGINS, (err: Error | null) => {
              if (err) {
                logger.error(`Extraction error: ${err.message}`);
                reject(err);
              } else {
                resolve();
              }
            });
          });
          
          // Success, break out of retry loop
          break;
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
            progressCallback?.({ 
              progress: 80 + Math.round((attempt / maxRetries) * 10), 
              message: `${componentName} - file locked, retrying (${attempt}/${maxRetries})...` 
            });
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            continue;
          }
          
          // If it's not a file lock error, or we've exhausted retries, throw
          if (attempt === maxRetries) {
            logger.error(`Failed to extract after ${maxRetries} attempts`);
            throw lastError;
          }
          throw err;
        }
      }

      // Clean up
      progressCallback?.({ progress: 90, message: 'Cleaning up temporary files...' });
      await fs.remove(archivePath);
      logger.info(`Removed archive: ${archivePath}`);

      progressCallback?.({ progress: 100, message: `${componentName} installed successfully!` });
      logger.info(`=== ${componentName} installation completed ===`);

    } catch (error) {
      logger.error(`Error installing ${componentName}:`, error);
      // Clean up on error
      if (await fs.pathExists(archivePath)) {
        await fs.remove(archivePath);
      }
      throw error;
    }
  }

  /**
   * Create a progress callback that sends updates to a BrowserWindow
   */
  static createWindowProgressCallback(
    window: BrowserWindow | null,
    eventName: string
  ): VsMlrtProgressCallback {
    return (progress: VsMlrtDownloadProgress) => {
      if (window) {
        window.webContents.send(eventName, progress);
      }
    };
  }
}
