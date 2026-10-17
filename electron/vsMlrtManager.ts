// electron/vsMlrtManager.ts
import { BrowserWindow } from 'electron';
import { VS_MLRT_VERSION, PYPI_EXTRA_INDEX_ARGS } from './constants';
import { pipInstall, throwIfFailed, withPipLock } from './pip';
import { logger } from './logger';
import { applyPluginCompatibilityFixes } from './legacyCleanup';
import { configManager } from './configManager';
import { getProvider, type BackendId } from './providers/registry';

export type VsMlrtComponent = 'tensorrt';

export interface VsMlrtDownloadProgress {
  progress: number;
  message: string;
}

export type VsMlrtProgressCallback = (progress: VsMlrtDownloadProgress) => void;

// Component names → inference backend ids; package specs come from the
// backend's provider module.
const COMPONENT_BACKEND: Record<VsMlrtComponent, BackendId> = {
  'tensorrt': 'tensorrt',
};

/**
 * Installs the vs-mlrt inference plugins from PyPI.
 *
 * The wheels install into site-packages/vapoursynth/plugins/{ort,trt} where
 * VapourSynth autoloads them; TensorRT itself comes from NVIDIA's PyPI index as
 * a dependency of vapoursynth-mlrt-trt.
 */
export class VsMlrtManager {
  /**
   * Get the PyPI requirements for a specific vs-mlrt component
   */
  static getPipRequirements(component: VsMlrtComponent): string[] {
    return getProvider(COMPONENT_BACKEND[component]).pipPackages();
  }

  /**
   * Get the component name for display purposes
   */
  static getComponentName(component: VsMlrtComponent): string {
    switch (component) {
      case 'tensorrt':
        return `vs-mlrt TensorRT v${VS_MLRT_VERSION}`;
    }
  }

  /**
   * Install or update a vs-mlrt component via pip
   */
  static async downloadAndInstall(
    component: VsMlrtComponent,
    progressCallback?: VsMlrtProgressCallback
  ): Promise<void> {
    const componentName = VsMlrtManager.getComponentName(component);
    const requirements = VsMlrtManager.getPipRequirements(component);

    logger.info(`=== Installing ${componentName} from PyPI ===`);
    progressCallback?.({ progress: 5, message: `Preparing to install ${componentName}...` });

    let lastProgress = 5;
    const report = (progress: number, message: string) => {
      lastProgress = Math.max(lastProgress, progress);
      progressCallback?.({ progress: Math.min(lastProgress, 99), message });
    };
    const processLine = (trimmed: string) => {
      const collectingMatch = trimmed.match(/Collecting\s+([^\s(]+)/);
      if (collectingMatch) {
        report(15, `Collecting ${collectingMatch[1]}...`);
        return;
      }
      const downloadingMatch = trimmed.match(/Downloading\s+([^\s(]+)/);
      if (downloadingMatch) {
        report(40, `Downloading ${downloadingMatch[1]}...`);
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

    const step = `Installing ${componentName}`;
    // The compatibility fixes rewrite the plugins folder, so they run inside
    // the same hold of the environment as the install.
    await withPipLock(async () => {
      throwIfFailed(await pipInstall(requirements, {
        step,
        extraArgs: ['--upgrade', ...PYPI_EXTRA_INDEX_ARGS],
        onLine: processLine,
      }), step);

      // Re-resolve the ort/ort-cuda duplicate a reinstall may have recreated.
      // Prefer the vendor the installed set targets; the 'nvidia' fallback
      // covers configs predating vendor tracking.
      await applyPluginCompatibilityFixes(
        configManager.getPluginsGpuVendor() ?? configManager.getGpuVendor() ?? 'nvidia'
      );
    }, { label: 'vs-mlrt update' });

    progressCallback?.({ progress: 100, message: `${componentName} installed successfully!` });
    logger.info(`=== ${componentName} installation completed ===`);
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
