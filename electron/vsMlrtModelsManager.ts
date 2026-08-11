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

interface ModelFamily {
  /** Family folder name vsmlrt.py expects under models_path. */
  family: string;
  /** File (relative to VSMLRT_MODELS) whose presence marks the family installed. */
  marker: string;
}

interface ModelPack {
  /** Release asset to download. */
  url: string;
  /** Family folders to pull out of this one archive. */
  families: ModelFamily[];
}

// Per-model archives from the vs-mlrt model releases — deliberately the small
// per-model packs (~20MB RIFE v4.10, ~54MB DPIR), not the ~200MB+ bundles.
// The bundled RIFE template defaults to v4_10; other versions can be dropped
// into the same folder manually.
//
// One archive can carry several families: the RIFE packs ship both the v1
// representation (one concatenated input tensor, what vsmlrt uses by default
// and what the TensorRT backend builds cleanly) and the v2 representation
// (separate inputs), which a template can select with _implementation=2.
const MODEL_PACKS: ModelPack[] = [
  {
    url: 'https://github.com/AmusementClub/vs-mlrt/releases/download/external-models/rife_v4.10.7z',
    families: [
      { family: 'rife', marker: path.join('rife', 'rife_v4.10.onnx') },
      { family: 'rife_v2', marker: path.join('rife_v2', 'rife_v4.10.onnx') },
    ],
  },
  {
    url: 'https://github.com/AmusementClub/vs-mlrt/releases/download/model-20211209/dpir_v3.7z',
    families: [
      { family: 'dpir', marker: path.join('dpir', 'drunet_color.onnx') },
    ],
  },
];

export class VsMlrtModelsManager {
  private static downloadInFlight: Promise<void> | null = null;

  /** True when any bundled-template model family is missing. */
  static async needsDownload(): Promise<boolean> {
    for (const pack of MODEL_PACKS) {
      for (const family of pack.families) {
        if (!await VsMlrtModelsManager.isFamilyInstalled(family)) {
          return true;
        }
      }
    }
    return false;
  }

  private static isFamilyInstalled(family: ModelFamily): Promise<boolean> {
    return fs.pathExists(path.join(PATHS.VSMLRT_MODELS, family.marker));
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
      const missing: ModelFamily[] = [];
      for (const family of pack.families) {
        if (!await VsMlrtModelsManager.isFamilyInstalled(family)) {
          missing.push(family);
        }
      }
      if (missing.length === 0) {
        continue;
      }

      const archiveName = path.basename(new URL(pack.url).pathname);
      const label = missing.map(f => f.family).join(', ');
      logger.info(`vs-mlrt model families '${label}' missing — downloading ${archiveName}`);
      progressCallback?.(`Downloading ${label} models...`);

      const tempDir = path.join(PATHS.APP_DATA, 'temp');
      const archivePath = path.join(tempDir, archiveName);
      const extractPath = path.join(tempDir, `${path.parse(archiveName).name}-extracted`);

      try {
        await fs.ensureDir(tempDir);
        await VsMlrtModelsManager.downloadFile(pack.url, archivePath);

        progressCallback?.(`Extracting ${label} models...`);
        await fs.remove(extractPath);
        await fs.ensureDir(extractPath);
        await _7z.unpack(archivePath, extractPath);

        // One archive can hold several family folders; install each missing one
        for (const family of missing) {
          // Archives may root at models/<family>/ or <family>/ — find the family
          // folder and copy its contents to VSMLRT_MODELS/<family>/
          const familyDir = await VsMlrtModelsManager.findFamilyDir(extractPath, family.family);
          if (!familyDir) {
            throw new Error(`Extracted archive contains no '${family.family}' folder`);
          }

          const targetDir = path.join(PATHS.VSMLRT_MODELS, family.family);
          await fs.ensureDir(targetDir);
          await fs.copy(familyDir, targetDir, { overwrite: true });

          if (!await VsMlrtModelsManager.isFamilyInstalled(family)) {
            throw new Error(`Extraction finished but ${family.marker} is still missing`);
          }
          logger.info(`vs-mlrt model family '${family.family}' installed to ${targetDir}`);
        }
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
