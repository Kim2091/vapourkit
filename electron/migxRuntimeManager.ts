// electron/migxRuntimeManager.ts
//
// Installs the Windows build of vs-mlrt's MIGraphX plugin. Linux gets it from
// the vapoursynth-mlrt-migx pip wheel, but no pip index carries a Windows
// build, so it comes from the vs-mlrt GitHub release as two archives:
//
//   VSMIGX-Windows-x64.<tag>.7z   vsmigx.dll                    (130 KB)
//   vsmlrt-hip.<tag>.7z           vsmlrt-hip\ HIP + MIGraphX    (68 MB, 383 MB unpacked)
//
// Both unpack into PATHS.MIGX_PLUGIN_DIR (plugins\migx): vsmigx.dll preloads
// its runtime from the vsmlrt-hip folder beside itself. VapourSynth's autoload
// recurses into subfolders and would LoadLibrary every HIP/MIGraphX DLL on each
// start, so a manifest.vs limits plugins\migx to vsmigx.dll alone.
//
// A marker file records the release tag, so bumping VS_MLRT_MIGX_WINDOWS_RELEASE
// replaces the install. Only Windows AMD installs call this (see
// pluginInstaller and dependencyManager).

import * as path from 'path';
import * as fs from 'fs-extra';
import * as _7z from '7zip-min';
import { downloadToFile } from './download';
import { logger } from './logger';
import { PATHS, VS_MLRT_MIGX_WINDOWS_RELEASE } from './constants';

interface RuntimeArchive {
  name: string;
  sha256: string;
  /** A smaller body is an error page, not the archive. */
  minBytes: number;
}

const RELEASE_URL = `https://github.com/AmusementClub/vs-mlrt/releases/download/${VS_MLRT_MIGX_WINDOWS_RELEASE}`;

// Hashes of the v15.16 release assets. A tag bump must update these.
const ARCHIVES: RuntimeArchive[] = [
  {
    name: `VSMIGX-Windows-x64.${VS_MLRT_MIGX_WINDOWS_RELEASE}.7z`,
    sha256: '89cacabcf6390a341066de0cf83be80dd44dc8089fa0a65c77b15fed455db967',
    minBytes: 64 * 1024,
  },
  {
    name: `vsmlrt-hip.${VS_MLRT_MIGX_WINDOWS_RELEASE}.7z`,
    sha256: '906fa06eb384bb5f409b86f626cef5f0062c34ec167c957517b65d4560bedcd6',
    minBytes: 32 * 1024 * 1024,
  },
];

const VERSION_MARKER = '.vapourkit-release';

/** Loads only vsmigx.dll from plugins\migx; see the header comment. */
export const MIGX_MANIFEST = '[VapourSynth Manifest V1]\nvsmigx\n';

/** Files whose presence (plus the marker) means the runtime is usable. */
function requiredFiles(dir: string): string[] {
  return [
    path.join(dir, 'vsmigx.dll'),
    path.join(dir, 'manifest.vs'),
    path.join(dir, 'vsmlrt-hip', 'migraphx_c.dll'),
    path.join(dir, 'vsmlrt-hip', 'amdhip64_6.dll'),
    path.join(dir, 'vsmlrt-hip', 'migraphx-driver.exe'),
  ];
}

export class MigxRuntimeManager {
  private static installInFlight: Promise<void> | null = null;

  /** True when the runtime is missing, incomplete, or from another release. */
  static async needsInstall(dir: string = PATHS.MIGX_PLUGIN_DIR): Promise<boolean> {
    for (const file of requiredFiles(dir)) {
      if (!await fs.pathExists(file)) {
        return true;
      }
    }
    const marker = await fs.readFile(path.join(dir, VERSION_MARKER), 'utf-8').catch(() => '');
    return marker.trim() !== VS_MLRT_MIGX_WINDOWS_RELEASE;
  }

  /**
   * Downloads and installs the runtime when needed. Concurrent callers share
   * one run. As with VsMlrtModelsManager, `signal` aborts the download only for
   * the caller that started it; a joining caller just stops waiting.
   */
  static async ensureRuntime(progressCallback?: (message: string) => void, signal?: AbortSignal): Promise<void> {
    if (!MigxRuntimeManager.installInFlight) {
      MigxRuntimeManager.installInFlight = MigxRuntimeManager.install(progressCallback, signal)
        .finally(() => { MigxRuntimeManager.installInFlight = null; });
      return MigxRuntimeManager.installInFlight;
    }
    return MigxRuntimeManager.untilAborted(MigxRuntimeManager.installInFlight, signal);
  }

  private static untilAborted(run: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) return run;
    if (signal.aborted) return Promise.reject(new Error('MIGraphX runtime download cancelled'));
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new Error('MIGraphX runtime download cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
      run.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  private static async install(progressCallback?: (message: string) => void, signal?: AbortSignal): Promise<void> {
    if (!await MigxRuntimeManager.needsInstall()) {
      return;
    }

    const tempDir = path.join(PATHS.APP_DATA, 'temp');
    // Staged outside the plugins folder: VapourSynth's autoload recurses, so a
    // half-extracted runtime there would be loaded by any vspipe started meanwhile.
    const stagingDir = path.join(tempDir, 'migx-runtime');
    const archivePaths: string[] = [];

    logger.info(`MIGraphX runtime missing or outdated — installing vs-mlrt ${VS_MLRT_MIGX_WINDOWS_RELEASE} build`);
    try {
      await fs.ensureDir(tempDir);
      await fs.remove(stagingDir);
      await fs.ensureDir(stagingDir);

      for (const archive of ARCHIVES) {
        if (signal?.aborted) {
          throw new Error('MIGraphX runtime download cancelled');
        }
        const archivePath = path.join(tempDir, archive.name);
        archivePaths.push(archivePath);
        progressCallback?.('Downloading the MIGraphX runtime...');
        await downloadToFile(`${RELEASE_URL}/${archive.name}`, archivePath, {
          label: 'MIGraphX runtime',
          minBytes: archive.minBytes,
          expectedSha256: archive.sha256,
          signal,
          onProgress: ({ received, total }) => {
            if (total) {
              progressCallback?.(`Downloading the MIGraphX runtime... ${Math.round((received * 100) / total)}%`);
            }
          },
        });
        progressCallback?.('Extracting the MIGraphX runtime...');
        await _7z.unpack(archivePath, stagingDir);
      }

      await fs.writeFile(path.join(stagingDir, 'manifest.vs'), MIGX_MANIFEST);
      await fs.writeFile(path.join(stagingDir, VERSION_MARKER), `${VS_MLRT_MIGX_WINDOWS_RELEASE}\n`);

      const missing: string[] = [];
      for (const file of requiredFiles(stagingDir)) {
        if (!await fs.pathExists(file)) {
          missing.push(path.relative(stagingDir, file));
        }
      }
      if (missing.length > 0) {
        throw new Error(`MIGraphX runtime archives are missing ${missing.join(', ')}`);
      }

      await fs.remove(PATHS.MIGX_PLUGIN_DIR);
      await fs.move(stagingDir, PATHS.MIGX_PLUGIN_DIR);
      logger.info(`MIGraphX runtime installed to ${PATHS.MIGX_PLUGIN_DIR}`);
    } finally {
      await fs.remove(stagingDir).catch(() => {});
      for (const archivePath of archivePaths) {
        await fs.remove(archivePath).catch(() => {});
      }
    }
  }

  /** Removes the Windows runtime (a vendor change away from AMD). */
  static async remove(): Promise<void> {
    if (await fs.pathExists(PATHS.MIGX_PLUGIN_DIR)) {
      await fs.remove(PATHS.MIGX_PLUGIN_DIR);
      logger.info(`Removed the MIGraphX runtime from ${PATHS.MIGX_PLUGIN_DIR}`);
    }
  }
}
