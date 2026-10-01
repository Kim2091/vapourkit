// electron/rocmEnvironment.ts
//
// Which ROCm install the MIGraphX backend runs against on Linux.
//
// The MIGraphX plugin (vapoursynth-mlrt-migx) links libmigraphx_c.so.3 and
// libamdhip64.so.7 from a system ROCm, and vsmlrt compiles models with that
// install's migraphx-driver. Machines often carry more than one ROCm - a
// distro or AMD package in /opt/rocm next to a TheRock tarball on the user's
// LD_LIBRARY_PATH - and MIGraphX breaks when it loads another install's
// libraries: a newer amd_comgr's clang rejected MIGraphX 2.15's own kernels
// ("-Werror,-Wlifetime-safety-intra-tu-suggestions"). And /opt/rocm/lib is
// often missing from the loader cache, added only by a shell profile that an
// AppImage started from the desktop never reads.
//
// So the install is a setting:
//   auto         $ROCM_PATH, else /opt/rocm
//   environment  leave the loader paths to the user's own environment
//   custom       a ROCm root the user picks
// auto and custom put <root>/lib first on LD_LIBRARY_PATH, set ROCM_PATH, and
// name <root>/bin/migraphx-driver for vsmlrt. The bundled plugin wheels are
// unaffected: their vendored libraries carry hashed names.
//
// Imports nothing from configManager (which imports utils, which uses this);
// configManager pushes the setting in with setRocmSetting.

import * as fs from 'fs';
import * as path from 'path';

export type RocmMode = 'auto' | 'environment' | 'custom';

export interface RocmSetting {
  mode: RocmMode;
  /** The ROCm root for custom mode, e.g. ~/therock-tarball/install */
  customRoot?: string;
}

export const DEFAULT_ROCM_SETTING: RocmSetting = { mode: 'auto' };

let current: RocmSetting = DEFAULT_ROCM_SETTING;

export function setRocmSetting(setting: RocmSetting | undefined): void {
  current = setting ?? DEFAULT_ROCM_SETTING;
}

export function getRocmSetting(): RocmSetting {
  return current;
}

/**
 * The ROCm root the setting picks, or null when Vapourkit should not touch the
 * loader paths: off Linux, in environment mode, or when the chosen root has no
 * lib folder.
 */
export function resolveRocmRoot(
  setting: RocmSetting = current,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (dir: string) => boolean = fs.existsSync,
): string | null {
  if (platform !== 'linux' || setting.mode === 'environment') return null;
  const root = setting.mode === 'custom'
    ? setting.customRoot?.trim()
    : env['ROCM_PATH'] || '/opt/rocm';
  if (!root) return null;
  return exists(path.join(root, 'lib')) ? root : null;
}

/**
 * Puts a library folder first in a library path, moving it up if it is
 * already listed. First, so another ROCm on the user's path cannot win.
 */
export function prependLibraryPath(current: string | undefined, dir: string | null): string | undefined {
  if (!dir) return current;
  const others = (current ?? '').split(':').filter(entry => entry && entry !== dir);
  return [dir, ...others].join(':');
}

/**
 * Applies the setting to a child environment in place: <root>/lib first on
 * LD_LIBRARY_PATH, ROCM_PATH, and VK_MIGRAPHX_DRIVER, which the generated
 * script hands to vsmlrt. Leaves the environment alone when resolveRocmRoot
 * gives nothing.
 */
export function applyRocmEnvironment(
  env: NodeJS.ProcessEnv,
  setting: RocmSetting = current,
  platform: NodeJS.Platform = process.platform,
  exists: (dir: string) => boolean = fs.existsSync,
): NodeJS.ProcessEnv {
  const root = resolveRocmRoot(setting, env, platform, exists);
  if (!root) return env;
  env['LD_LIBRARY_PATH'] = prependLibraryPath(env['LD_LIBRARY_PATH'], path.join(root, 'lib'));
  env['ROCM_PATH'] = root;
  env['VK_MIGRAPHX_DRIVER'] = path.join(root, 'bin', 'migraphx-driver');
  return env;
}

export interface RocmStatus {
  /** False off Linux, where the setting does not apply */
  supported: boolean;
  /** The root the setting resolves to, null in environment mode or when missing */
  root: string | null;
  /** MIGraphX version read from libmigraphx.so.<MMmmmppp>, when present */
  migraphxVersion: string | null;
  hasMigraphxLibrary: boolean;
  hasMigraphxDriver: boolean;
  /** One line for the settings panel */
  summary: string;
}

/**
 * The MIGraphX version from a library file name: libmigraphx.so.2015000 is
 * 2.15.0 (major, then three digits each of minor and patch).
 */
export function migraphxVersionFromFileName(name: string): string | null {
  const match = /^libmigraphx\.so\.(\d+)(\d{3})(\d{3})$/.exec(name);
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : null;
}

/** What the setting resolves to on this machine, for the settings panel. */
export function describeRocm(
  setting: RocmSetting = current,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): RocmStatus {
  const none = { root: null, migraphxVersion: null, hasMigraphxLibrary: false, hasMigraphxDriver: false };
  if (platform !== 'linux') {
    return { supported: false, ...none, summary: 'Only used on Linux.' };
  }
  if (setting.mode === 'environment') {
    return {
      supported: true, ...none,
      summary: 'Using your environment: LD_LIBRARY_PATH and the loader cache decide which ROCm loads.',
    };
  }

  if (setting.mode === 'custom' && !setting.customRoot?.trim()) {
    return { supported: true, ...none, summary: 'Choose your ROCm folder (the one containing lib and bin).' };
  }

  const root = resolveRocmRoot(setting, env, platform);
  if (!root) {
    const wanted = setting.mode === 'custom' ? setting.customRoot!.trim() : (env['ROCM_PATH'] || '/opt/rocm');
    return { supported: true, ...none, summary: `${wanted}: no ROCm lib folder found.` };
  }

  const lib = path.join(root, 'lib');
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(lib);
  } catch {
    // An unreadable folder reads as one without MIGraphX
  }
  const hasMigraphxLibrary = entries.includes('libmigraphx_c.so.3');
  const migraphxVersion = entries.map(migraphxVersionFromFileName).find(Boolean) ?? null;
  const hasMigraphxDriver = fs.existsSync(path.join(root, 'bin', 'migraphx-driver'));

  let summary: string;
  if (hasMigraphxLibrary && hasMigraphxDriver) {
    summary = `${root}: MIGraphX ${migraphxVersion ?? '(version unknown)'} found.`;
  } else if (!hasMigraphxLibrary) {
    summary = `${root}: no libmigraphx_c.so.3, so the MIGraphX backend cannot load from here.`;
  } else {
    summary = `${root}: MIGraphX library found, but no bin/migraphx-driver to compile models with.`;
  }
  return { supported: true, root, migraphxVersion, hasMigraphxLibrary, hasMigraphxDriver, summary };
}
