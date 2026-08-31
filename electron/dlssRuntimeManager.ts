import fs from 'fs-extra';
import path from 'path';
import { promisify } from 'util';
import { execFile } from 'child_process';

import { PATHS } from './constants';
import { logger } from './logger';

const execFileAsync = promisify(execFile);

/**
 * Importing the DLSS 5 Neural Uplift runtime (nvngx_dlssnr.dll).
 *
 * The DLL is not shipped with the NVIDIA driver and is not in any public NVIDIA release, so it
 * cannot be downloaded or bundled - it reaches users inside games that integrate DLSS 5. All
 * this module does is take a file the user picked and put it where the plugin looks for it, so
 * nobody has to find the VapourSynth plugins folder by hand.
 */

/** The filename the plugin looks for. */
const RUNTIME_FILENAME = 'nvngx_dlssnr.dll';

/**
 * Smallest plausible size. The 310.8 runtime is ~158 MiB; this rejects a truncated copy or a
 * stub with the right name, rather than pinning an exact build.
 */
const MIN_RUNTIME_BYTES = 50 * 1024 * 1024;

/**
 * The VERSIONINFO field that identifies which NGX feature a DLL implements.
 *
 * It has to be this rather than the export table: every NGX snippet exports the same
 * NVSDK_NGX_D3D12_* entry points - that is how the NGX core calls into them - so exports prove
 * a file is a snippet but say nothing about which one. nvngx_dlss.dll reports "DLSS",
 * nvngx_dlssg.dll reports "DLSS-G", and the one we want reports "DLSSNR".
 */
const RUNTIME_INTERNAL_NAME = 'DLSSNR';

export interface DlssRuntimeStatus {
  installed: boolean;
  installedVersion: string | null;
  /** Where the runtime goes, so a user who would rather copy it themselves can. */
  targetDirectory: string;
}

export interface DlssImportResult {
  success: boolean;
  canceled?: boolean;
  error?: string;
  version?: string | null;
}

export interface DlssValidationResult {
  valid: boolean;
  reason?: string;
  version: string | null;
}

interface VersionInfo {
  fileVersion: string | null;
  productName: string | null;
  internalName: string | null;
}

/** Version resource via the shell, which is far cheaper than parsing VERSIONINFO by hand. */
async function readVersionInfo(filePath: string): Promise<VersionInfo> {
  const empty: VersionInfo = { fileVersion: null, productName: null, internalName: null };

  try {
    const literal = filePath.replace(/'/g, "''");
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$v = (Get-Item -LiteralPath '${literal}').VersionInfo; ` +
          '[PSCustomObject]@{ FileVersion = $v.FileVersion; ProductName = $v.ProductName; ' +
          'InternalName = $v.InternalName } | ConvertTo-Json -Compress',
      ],
      { timeout: 15000, windowsHide: true },
    );

    const raw = stdout.trim();
    if (!raw) {
      return empty;
    }

    const parsed = JSON.parse(raw) as {
      FileVersion?: string | null;
      ProductName?: string | null;
      InternalName?: string | null;
    };

    return {
      // NVIDIA writes the version with commas ("310,8,0,0"); dots are what users expect to read.
      fileVersion: parsed.FileVersion ? parsed.FileVersion.replace(/,/g, '.').trim() : null,
      productName: parsed.ProductName?.trim() || null,
      internalName: parsed.InternalName?.trim() || null,
    };
  } catch {
    return empty;
  }
}

/**
 * Checks that a picked file really is the DLSS 5 runtime.
 *
 * Worth doing because the failure it prevents is otherwise silent and confusing: the wrong NGX
 * DLL copies into place happily and then fails at filter-create time with a bare NGX result
 * code. Naming the mistake at import time is the difference between "you picked nvngx_dlss.dll"
 * and an hour of confusion.
 */
export async function validateRuntimeFile(filePath: string): Promise<DlssValidationResult> {
  let sizeBytes: number;

  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      return { valid: false, reason: 'That path is not a file.', version: null };
    }
    sizeBytes = stats.size;
  } catch {
    return { valid: false, reason: 'That file could not be read.', version: null };
  }

  if (sizeBytes < MIN_RUNTIME_BYTES) {
    return {
      valid: false,
      reason:
        `That file is only ${(sizeBytes / (1024 * 1024)).toFixed(1)} MB. The DLSS 5 runtime is ` +
        'around 158 MB, so this is either a different DLL or an incomplete copy.',
      version: null,
    };
  }

  const info = await readVersionInfo(filePath);

  if (info.internalName === null) {
    return {
      valid: false,
      reason: 'That file has no version information, so it is not an NVIDIA NGX runtime.',
      version: null,
    };
  }

  if (info.internalName !== RUNTIME_INTERNAL_NAME) {
    return {
      valid: false,
      reason:
        `That is ${info.productName ?? info.internalName}, not the DLSS 5 Neural Uplift runtime. ` +
        `Look for ${RUNTIME_FILENAME} rather than nvngx_dlss.dll or nvngx_dlssg.dll.`,
      version: null,
    };
  }

  return { valid: true, version: info.fileVersion };
}

function installedRuntimePath(): string {
  return path.join(PATHS.PLUGINS, RUNTIME_FILENAME);
}

export async function getRuntimeStatus(): Promise<DlssRuntimeStatus> {
  const target = installedRuntimePath();

  if (!(await fs.pathExists(target))) {
    return { installed: false, installedVersion: null, targetDirectory: PATHS.PLUGINS };
  }

  const info = await readVersionInfo(target);
  return { installed: true, installedVersion: info.fileVersion, targetDirectory: PATHS.PLUGINS };
}

/**
 * Copies a validated runtime into the plugin folder.
 *
 * Written under a temporary name and renamed into place, so an interrupted copy of a 158 MB
 * file cannot leave something that looks installed and fails at load.
 */
export async function importRuntimeFromPath(sourcePath: string): Promise<DlssImportResult> {
  const validation = await validateRuntimeFile(sourcePath);
  if (!validation.valid) {
    return { success: false, error: validation.reason };
  }

  const target = installedRuntimePath();

  if (path.resolve(sourcePath).toLowerCase() === path.resolve(target).toLowerCase()) {
    return { success: true, version: validation.version };
  }

  const staging = `${target}.incoming`;

  try {
    await fs.ensureDir(PATHS.PLUGINS);
    await fs.remove(staging);
    await fs.copy(sourcePath, staging, { overwrite: true });
    await fs.remove(target);
    await fs.move(staging, target);

    logger.info(`Imported DLSS 5 runtime (${validation.version ?? 'unknown version'}) to ${target}`);
    return { success: true, version: validation.version };
  } catch (error) {
    await fs.remove(staging).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to import DLSS 5 runtime:', error);
    return { success: false, error: message };
  }
}
