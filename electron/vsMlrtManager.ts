// electron/vsMlrtManager.ts
import * as fs from 'fs-extra';
import { spawn } from 'child_process';
import { BrowserWindow } from 'electron';
import { PATHS, VS_MLRT_VERSION, PYPI_EXTRA_INDEX_ARGS } from './constants';
import { logger } from './logger';
import { applyPluginCompatibilityFixes } from './legacyCleanup';

export type VsMlrtComponent = 'onnx-runtime' | 'tensorrt';

export interface VsMlrtDownloadProgress {
  progress: number;
  message: string;
}

export type VsMlrtProgressCallback = (progress: VsMlrtDownloadProgress) => void;

/**
 * Installs the vs-mlrt inference plugins from PyPI.
 *
 * The wheels install into site-packages/vapoursynth/plugins/{ort,trt} where
 * VapourSynth autoloads them; TensorRT itself comes from NVIDIA's PyPI index as
 * a dependency of vapoursynth-mlrt-trt.
 */
export class VsMlrtManager {
  /**
   * Get the PyPI requirement for a specific vs-mlrt component
   */
  static getPipRequirement(component: VsMlrtComponent): string {
    switch (component) {
      case 'onnx-runtime':
        return `vapoursynth-mlrt-ort==${VS_MLRT_VERSION}`;
      case 'tensorrt':
        return `vapoursynth-mlrt-trt==${VS_MLRT_VERSION}`;
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
   * Get the check paths that indicate a component is installed (any match counts)
   */
  static getCheckPaths(component: VsMlrtComponent): string[] {
    switch (component) {
      case 'onnx-runtime':
        // The CPU-only "ort" folder is removed when the CUDA build is present
        return [PATHS.ORT_CUDA_PLUGIN_DLL, PATHS.ORT_PLUGIN_DLL];
      case 'tensorrt':
        return [PATHS.TRT_PLUGIN_DLL];
    }
  }

  /**
   * Check if a component is installed
   */
  static async isComponentInstalled(component: VsMlrtComponent): Promise<boolean> {
    for (const checkPath of VsMlrtManager.getCheckPaths(component)) {
      if (await fs.pathExists(checkPath)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Install or update a vs-mlrt component via pip
   */
  static async downloadAndInstall(
    component: VsMlrtComponent,
    progressCallback?: VsMlrtProgressCallback
  ): Promise<void> {
    const componentName = VsMlrtManager.getComponentName(component);
    const requirement = VsMlrtManager.getPipRequirement(component);

    logger.info(`=== Installing ${componentName} from PyPI ===`);
    progressCallback?.({ progress: 5, message: `Preparing to install ${componentName}...` });

    const args = [
      '-m', 'pip', 'install',
      '--upgrade',
      '--no-warn-script-location',
      '--cache-dir', PATHS.PIP_CACHE,
      requirement,
      ...PYPI_EXTRA_INDEX_ARGS,
    ];

    logger.info(`Running command: ${PATHS.PYTHON} ${args.join(' ')}`);

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(PATHS.PYTHON, args, {
        cwd: PATHS.VS,
        windowsHide: true
      });

      let errorBuffer = '';
      let lastProgress = 5;

      const report = (progress: number, message: string) => {
        lastProgress = Math.max(lastProgress, progress);
        progressCallback?.({ progress: Math.min(lastProgress, 99), message });
      };

      const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        logger.info(`[pip] ${trimmed}`);

        const collectingMatch = trimmed.match(/Collecting\s+([^\s(]+)/);
        if (collectingMatch) {
          report(15, `Collecting ${collectingMatch[1]}...`);
          return;
        }

        const percentMatch = trimmed.match(/(\d+)%/);
        if (percentMatch) {
          const percent = parseInt(percentMatch[1], 10);
          report(15 + percent * 0.7, `Downloading... ${percent}%`);
          return;
        }

        if (trimmed.includes('Installing collected packages')) {
          report(90, 'Installing packages...');
          return;
        }

        if (trimmed.includes('Successfully installed')) {
          report(98, `${componentName} installed`);
        }
      };

      proc.stdout?.on('data', (data: Buffer) => {
        data.toString().split('\n').forEach(processLine);
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const output = data.toString();
        errorBuffer += output;
        output.split('\n').forEach(processLine);
      });

      proc.on('close', async (code: number | null) => {
        if (code === 0) {
          // Re-resolve the ort/ort-cuda duplicate a reinstall may have recreated
          await applyPluginCompatibilityFixes();
          progressCallback?.({ progress: 100, message: `${componentName} installed successfully!` });
          logger.info(`=== ${componentName} installation completed ===`);
          resolve();
        } else {
          const errorMsg = `pip install of ${componentName} failed with exit code ${code}: ${errorBuffer.trim()}`;
          logger.error(errorMsg);
          reject(new Error(errorMsg));
        }
      });

      proc.on('error', (error: Error) => {
        logger.error(`Failed to start pip for ${componentName}:`, error);
        reject(error);
      });
    });
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
