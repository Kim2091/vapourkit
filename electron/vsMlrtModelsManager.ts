// electron/vsMlrtModelsManager.ts
//
// Downloads the vs-mlrt model zoo files that the bundled .vkfilter templates
// use (RIFE frame interpolation, DPIR denoise/deblock). The old zip-based
// vs-mlrt releases shipped a models/ folder next to the plugin DLLs, but the
// PyPI wheels don't, so vsmlrt.py's RIFE()/DPIR() wrappers have nothing to
// load. The packs land in an app-controlled folder (PATHS.VSMLRT_MODELS) that
// pip reinstalls can never touch; generated scripts point vsmlrt.models_path
// at it (see scriptGenerator).

import * as path from 'path';
import * as fs from 'fs-extra';
import * as https from 'https';
import * as _7z from '7zip-min';
import { logger } from './logger';
import { PATHS } from './constants';

interface ModelPack {
  /** Family folder name vsmlrt.py expects under models_path. */
  family: string;
  /** Release asset to download. */
  url: string;
  /** File (relative to VSMLRT_MODELS) whose presence marks the pack installed. */
  marker: string;
}

// Per-family archives from the vs-mlrt model releases — deliberately the small
// per-model packs (~20MB RIFE v4.10, ~54MB DPIR), not the ~200MB+ bundles.
// The bundled RIFE template defaults to v4_10; other versions can be dropped
// into the same folder manually.
const MODEL_PACKS: ModelPack[] = [
  {
    family: 'rife',
    url: 'https://github.com/AmusementClub/vs-mlrt/releases/download/external-models/rife_v4.10.7z',
    marker: path.join('rife', 'rife_v4.10.onnx'),
  },
  {
    family: 'dpir',
    url: 'https://github.com/AmusementClub/vs-mlrt/releases/download/model-20211209/dpir_v3.7z',
    marker: path.join('dpir', 'drunet_color.onnx'),
  },
];

export class VsMlrtModelsManager {
  private static downloadInFlight: Promise<void> | null = null;

  /** True when any bundled-template model pack is missing. */
  static async needsDownload(): Promise<boolean> {
    for (const pack of MODEL_PACKS) {
      if (!await fs.pathExists(path.join(PATHS.VSMLRT_MODELS, pack.marker))) {
        return true;
      }
    }
    return false;
  }

  /**
   * Downloads and extracts any missing packs. Concurrent callers share one
   * run (checkDependencies fires this on every app mount).
   */
  static async ensureModels(progressCallback?: (message: string) => void): Promise<void> {
    if (!VsMlrtModelsManager.downloadInFlight) {
      VsMlrtModelsManager.downloadInFlight = VsMlrtModelsManager.downloadMissing(progressCallback)
        .finally(() => { VsMlrtModelsManager.downloadInFlight = null; });
    }
    return VsMlrtModelsManager.downloadInFlight;
  }

  private static async downloadMissing(progressCallback?: (message: string) => void): Promise<void> {
    for (const pack of MODEL_PACKS) {
      const markerPath = path.join(PATHS.VSMLRT_MODELS, pack.marker);
      if (await fs.pathExists(markerPath)) {
        continue;
      }

      const archiveName = path.basename(new URL(pack.url).pathname);
      logger.info(`vs-mlrt model pack '${pack.family}' missing — downloading ${archiveName}`);
      progressCallback?.(`Downloading ${pack.family} models...`);

      const tempDir = path.join(PATHS.APP_DATA, 'temp');
      const archivePath = path.join(tempDir, archiveName);
      const extractPath = path.join(tempDir, `${pack.family}-models-extracted`);

      try {
        await fs.ensureDir(tempDir);
        await VsMlrtModelsManager.downloadFile(pack.url, archivePath);

        progressCallback?.(`Extracting ${pack.family} models...`);
        await fs.remove(extractPath);
        await fs.ensureDir(extractPath);
        await _7z.unpack(archivePath, extractPath);

        // Archives may root at models/<family>/ or <family>/ — find the family
        // folder and move its contents under VSMLRT_MODELS/<family>/
        const familyDir = await VsMlrtModelsManager.findFamilyDir(extractPath, pack.family);
        if (!familyDir) {
          throw new Error(`Extracted archive contains no '${pack.family}' folder`);
        }

        const targetDir = path.join(PATHS.VSMLRT_MODELS, pack.family);
        await fs.ensureDir(targetDir);
        await fs.copy(familyDir, targetDir, { overwrite: true });

        if (!await fs.pathExists(markerPath)) {
          throw new Error(`Extraction finished but ${pack.marker} is still missing`);
        }
        logger.info(`vs-mlrt model pack '${pack.family}' installed to ${targetDir}`);
      } finally {
        await fs.remove(archivePath).catch(() => {});
        await fs.remove(extractPath).catch(() => {});
      }
    }
  }

  /** Locates the family folder in the extracted tree (depth ≤ 2). */
  private static async findFamilyDir(root: string, family: string): Promise<string | null> {
    const direct = path.join(root, family);
    if (await fs.pathExists(direct)) {
      return direct;
    }
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const nested = path.join(root, entry.name, family);
        if (await fs.pathExists(nested)) {
          return nested;
        }
      }
    }
    return null;
  }

  /** Simple https download following redirects (GitHub release assets redirect). */
  private static downloadFile(url: string, outputPath: string, redirectsLeft: number = 5): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const request = https.get(url, (response) => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          if (redirectsLeft <= 0) {
            reject(new Error(`Too many redirects downloading ${url}`));
            return;
          }
          VsMlrtModelsManager.downloadFile(response.headers.location, outputPath, redirectsLeft - 1)
            .then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Download failed with HTTP ${response.statusCode}: ${url}`));
          return;
        }
        const file = fs.createWriteStream(outputPath);
        response.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', (err) => {
          file.close();
          fs.unlink(outputPath, () => {});
          reject(err);
        });
      });
      request.on('error', (err) => {
        fs.unlink(outputPath, () => {});
        reject(err);
      });
    });
  }
}
