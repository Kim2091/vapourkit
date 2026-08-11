// electron/legacyCleanup.ts
import * as path from 'path';
import * as fs from 'fs-extra';
import { logger } from './logger';
import { PATHS } from './constants';
import type { GpuVendor } from './gpuDetection';

/**
 * Bundled plugin DLLs superseded by PyPI wheels that install under a DIFFERENT
 * filename (e.g. bundled libmvtools.dll vs pip mvtools.dll, or a per-plugin
 * subfolder). Both copies would autoload and the alphabetically-first one wins,
 * so the stale bundled copy must be removed.
 *
 * IMPORTANT: never list a name a pip wheel installs at the same path
 * (case-insensitively) — that would delete the pip-managed file on reinstall
 * runs. Same-named files (fmtconv.dll, cas.dll, wnnm.dll, ...) self-heal
 * instead: the bundle is extracted with skip-existing semantics and pip
 * overwrites bundled copies when it installs, so the pip version always wins.
 */
export const SUPERSEDED_PLUGIN_FILES: string[] = [
  // vs-mlrt (pip installs into ort/, ort-cuda/, trt/ subfolders)
  'vsort.dll',
  'vsort',
  'vstrt.dll',
  'vsmlrt-cuda',
  // BestSource (pip: libbestsource.dll)
  'bestsource.dll',
  // pip wheels using per-plugin subfolders
  'akarin.dll',
  'vszip.dll',
  'zsmooth.dll',
  'manipmv.dll',
  'hysteresis.dll',
  'dfttest2_cuda.dll',
  'bm3dcuda_rtc.dll',
  'BilateralGPU_RTC.dll',
  'adaptivegrain_rs.dll',
  // pip wheels using a different root filename
  'libfillborders.dll',
  'vsznedi3.dll',
  'libsangnom.dll',
  'libawarpsharp2.dll',
  'libresize2.dll',
  'EEDI3m.dll',
  'libmvtools.dll',
  'libscxvid.dll',
];

/**
 * Python modules from the old bundled extra_scripts.7z that are now installed
 * from PyPI. vs-scripts is on the import path, so stale copies here would shadow
 * the pip-installed packages in site-packages.
 *
 * NOT listed (still bundled, not on PyPI): vs_deepdeinterlace, vsmlrt.py, the
 * Hybrid scripts.
 */
export const SUPERSEDED_SCRIPT_MODULES: string[] = [
  'vs_temporalfix',
  'vs_undistort',
  'vs_colorfix',
  'vs_colorfix.py',
  'vs_grain',
  'vs_grain.py',
  'vs_tiletools',
  'vs_tiletools.py',
  'dfttest2.py',
];

/**
 * Files and folders from the old VapourSynth R72 portable zip that used to live
 * at the root of the vapoursynth-portable folder. The runtime now comes from the
 * VapourSynth wheel in site-packages, so these must go — a stale vapoursynth.dll
 * or VSScript.dll on PATH could otherwise be picked up over the pip-managed one.
 */
const LEGACY_PORTABLE_ENTRIES: string[] = [
  'VSPipe.exe',
  'vspipe.exe',
  'VapourSynth.dll',
  'vapoursynth.dll',
  'VSScript.dll',
  'vsscript.dll',
  'VSVFW.dll',
  'vsvfw.dll',
  'VSScriptPython38.dll',
  'portable.vs',
  'wheel',
  'sdk',
  'doc',
  'vapoursynth64',
  'vs-plugins',
  '7z.exe',
  '7z.dll',
  'VapourSynth.chm',
  'vsrepo.py',
];

async function removeEntries(baseDir: string, entries: string[], label: string): Promise<void> {
  if (!await fs.pathExists(baseDir)) {
    return;
  }

  let removedCount = 0;
  for (const entry of entries) {
    const target = path.join(baseDir, entry);
    if (await fs.pathExists(target)) {
      try {
        await fs.remove(target);
        removedCount++;
        logger.info(`Removed superseded ${label}: ${entry}`);
      } catch (error) {
        logger.warn(`Failed to remove superseded ${label} ${entry}:`, error);
      }
    }
  }

  if (removedCount > 0) {
    logger.info(`Removed ${removedCount} superseded ${label} entr${removedCount === 1 ? 'y' : 'ies'} from ${baseDir}`);
  }
}

/**
 * Removes old plugin DLLs that PyPI wheels now provide. Runs against the
 * autoload plugins directory after the bundled plugins.7z is extracted, so only
 * plugins without a PyPI counterpart (mvtools, fft3dfilter, TCanny, ...) remain.
 */
export async function removeSupersededPlugins(pluginsDir: string = PATHS.PLUGINS): Promise<void> {
  await removeEntries(pluginsDir, SUPERSEDED_PLUGIN_FILES, 'plugin');
}

/**
 * Removes old script modules that PyPI packages now provide, plus stale bytecode.
 */
export async function removeSupersededScripts(scriptsDir: string = PATHS.SCRIPTS): Promise<void> {
  await removeEntries(scriptsDir, SUPERSEDED_SCRIPT_MODULES, 'script module');
  // Stale bytecode from removed modules; regenerated on demand for the rest.
  await removeEntries(scriptsDir, ['__pycache__'], 'script cache');
}

/**
 * Bundled plugin builds that crash the pip-installed VapourSynth (R79) outright.
 * API3 plugins generally still load through VapourSynth's compat bridge with a
 * deprecation warning, but these specific builds contain their own "v3 bridge"
 * guard that calls abort() when the core can't hand out an API3 VSAPI
 * ("v3bdg: unable to acquire api3 VSAPI, abort"), killing vspipe entirely.
 */
const CRASHING_PLUGIN_FILES: string[] = [
  'fft3dfilter.dll',
];

/**
 * Post-install plugin compatibility fixes:
 *
 * 1. Removes bundled plugin builds known to abort VapourSynth at autoload.
 * 2. Resolves the vs-mlrt ONNX Runtime duplicate for the machine's GPU vendor.
 *    Both vapoursynth-mlrt-ort (CPU/DirectML) and vapoursynth-mlrt-ort-cuda
 *    ship a vsort.dll, and autoload walks alphabetically, so whichever folder
 *    sorts first wins and the other is skipped as a duplicate:
 *      - nvidia: keep ort-cuda (a strict superset — it bundles DirectML too)
 *        and drop the plain "ort" folder that would otherwise win the race.
 *      - everything else: drop an orphaned ort-cuda folder left over from a
 *        previous CUDA-flavored install so the plain "ort" build — the only
 *        DirectML build actually installed on these vendors — survives.
 *    pip reinstalls restore the folders, which is fine: this runs after every
 *    install.
 *
 * Callers MUST pass the real vendor. The 'nvidia' default only exists so
 * pre-existing behavior is preserved for configs that predate vendor tracking;
 * calling it without a vendor on an AMD machine would delete the ort folder
 * that machine needs.
 */
export async function applyPluginCompatibilityFixes(
  vendor: GpuVendor = 'nvidia',
  pluginsDir: string = PATHS.PLUGINS
): Promise<void> {
  await removeEntries(pluginsDir, CRASHING_PLUGIN_FILES, 'crashing plugin');

  const ortCudaPlugin = path.join(pluginsDir, 'ort-cuda', 'vsort.dll');
  const ortCudaDir = path.join(pluginsDir, 'ort-cuda');
  const ortDir = path.join(pluginsDir, 'ort');

  if (vendor === 'nvidia') {
    if (await fs.pathExists(ortCudaPlugin) && await fs.pathExists(ortDir)) {
      try {
        await fs.remove(ortDir);
        logger.info('Removed duplicate CPU-only ort plugin folder (ort-cuda build takes precedence)');
      } catch (error) {
        logger.warn('Failed to remove duplicate ort plugin folder:', error);
      }
    }
    return;
  }

  if (await fs.pathExists(ortCudaDir)) {
    try {
      await fs.remove(ortCudaDir);
      logger.info(`Removed leftover CUDA ort plugin folder (GPU vendor: ${vendor}; the DirectML "ort" build takes precedence)`);
    } catch (error) {
      logger.warn('Failed to remove leftover ort-cuda plugin folder:', error);
    }
  }
}

/**
 * Migrates an install from the old zip-based layout (VapourSynth R72 portable +
 * vs-plugins DLL folder) to the pip-based layout. Detects the old layout by the
 * portable zip's root-level artifacts and removes them; the plugin install phase
 * re-provides everything from PyPI and the bundled archives.
 */
export async function migrateLegacyPortableLayout(): Promise<void> {
  const legacyMarkers = [
    path.join(PATHS.VS, 'portable.vs'),
    path.join(PATHS.VS, 'VSPipe.exe'),
    path.join(PATHS.VS, 'vs-plugins'),
  ];

  let isLegacy = false;
  for (const marker of legacyMarkers) {
    if (await fs.pathExists(marker)) {
      isLegacy = true;
      break;
    }
  }

  if (!isLegacy) {
    return;
  }

  logger.info('Old zip-based VapourSynth layout detected — migrating to the pip-based layout');
  await removeEntries(PATHS.VS, LEGACY_PORTABLE_ENTRIES, 'legacy portable file');
  await removeSupersededScripts();
  logger.info('Legacy portable layout migration complete');
}
