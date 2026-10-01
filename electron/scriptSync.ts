// electron/scriptSync.ts
//
// Keeps vs-scripts at the versions this app ships, file by file.
//
// vs-scripts is fed by more than one source (scriptSources.ts), and each used
// to be installed once, at plugin install, by overwriting everything. Now that
// an update keeps data\, a new pin or a rebuilt archive would never reach an
// updated install that way. So each source has a version, the manifest records
// every file each version ships, and the ledger records what this install
// received. Per file, three digests settle it, as they do for filter
// templates: installed against recorded says whether the user edited it,
// installed against the manifest whether it is current.
//
//   current                          nothing to do
//   missing, or untouched and stale  write it
//   edited                           keep it on an update, and say so;
//                                    replace it (backed up) on a reinstall
//   ours, no longer shipped          remove it if untouched
//
// Only a source with something to write is downloaded or extracted, so an
// update that changed no script costs nothing, and needs no network.

import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { app } from 'electron';
import * as _7z from '7zip-min';
import { PATHS } from './constants';
import { downloadToFile } from './download';
import { readLedger, writeLedger } from './installLedger';
import { logger } from './logger';
import { getBundledBasePath } from './utils';
import { SCRIPT_SOURCE_MANIFEST } from './scriptSourceManifest';
import { hybridScriptFiles, listFilesRecursive } from './scriptFiles';
import {
  BUNDLED_SCRIPT_ARCHIVES,
  HYBRID_SCRIPTS_SOURCE,
  HYBRID_SCRIPTS_URL,
  isSupersededScript,
  type ScriptSourceManifestEntry,
} from './scriptSources';

export interface ScriptLedgerEntry {
  version: string;
  appVersion: string;
  /** Path under vs-scripts to the digest of what was installed there */
  files: Record<string, string>;
}

export interface ScriptPlan {
  write: string[];
  remove: string[];
  /** Edited by the user and left alone */
  keptEdited: string[];
  /** The ledger's files for this source once the plan is carried out */
  files: Record<string, string>;
}

/**
 * What to do with one source. `force` is a reinstall: the user asked for the
 * shipped files back, so edits are replaced too (the executor backs them up).
 */
export function planScriptSync(
  manifest: ScriptSourceManifestEntry,
  installed: ReadonlyMap<string, string | undefined>,
  entry: ScriptLedgerEntry | undefined,
  force = false,
): ScriptPlan {
  const plan: ScriptPlan = { write: [], remove: [], keptEdited: [], files: {} };

  for (const file of Object.keys(manifest.files).sort()) {
    // Never ours to install, whatever a source carries: see SUPERSEDED_SCRIPT_MODULES.
    if (isSupersededScript(file)) continue;
    const shipped = manifest.files[file];
    const current = installed.get(file);
    const recorded = entry?.files[file];

    if (current === shipped) {
      plan.files[file] = shipped;
    } else if (current === undefined || force || current === recorded) {
      // Missing; a reinstall; or ours, untouched, and stale.
      plan.write.push(file);
      plan.files[file] = shipped;
    } else {
      // Edited. Without a record - an install from before the ledger - a
      // difference is still most likely an edit: every release before this
      // one installed these same sources. Its base becomes what ships now, so
      // it keeps reading as edited rather than as ours on the next update.
      plan.keptEdited.push(file);
      plan.files[file] = recorded ?? shipped;
    }
  }

  for (const file of Object.keys(entry?.files ?? {}).sort()) {
    if (file in manifest.files) continue;
    const current = installed.get(file);
    if (current !== undefined && current === entry!.files[file]) plan.remove.push(file);
  }

  return plan;
}

const sha256File = async (file: string) => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');

export interface ScriptSyncOptions {
  scriptsDir: string;
  /** include/scripts in the app bundle */
  bundledScriptsDir: string;
  /** Where an edited script goes before a reinstall replaces it */
  backupDir: string;
  tempDir: string;
  appVersion: string;
  mode: 'install' | 'update';
  /** Mutated in place; the caller writes it */
  ledger: Record<string, ScriptLedgerEntry>;
  download: (url: string, dest: string) => Promise<void>;
  unpack: (archive: string, into: string) => Promise<void>;
  onProgress?: (message: string) => void;
  manifest?: Readonly<Record<string, ScriptSourceManifestEntry>>;
}

export interface ScriptSyncResult {
  updated: string[];
  removed: string[];
  keptEdited: string[];
  /** A source that could not be fetched or applied; its ledger entry is left as it was */
  failed: { source: string; error: string }[];
}

export async function syncScriptSources(options: ScriptSyncOptions): Promise<ScriptSyncResult> {
  const manifest = options.manifest ?? SCRIPT_SOURCE_MANIFEST;
  const result: ScriptSyncResult = { updated: [], removed: [], keptEdited: [], failed: [] };
  await fs.ensureDir(options.scriptsDir);

  const sources = [HYBRID_SCRIPTS_SOURCE, ...BUNDLED_SCRIPT_ARCHIVES].filter(source => manifest[source]);
  for (const source of sources) {
    const shipped = manifest[source];
    const entry = options.ledger[source];

    const installed = new Map<string, string | undefined>();
    for (const file of new Set([...Object.keys(shipped.files), ...Object.keys(entry?.files ?? {})])) {
      const target = path.join(options.scriptsDir, ...file.split('/'));
      installed.set(file, await fs.pathExists(target) ? await sha256File(target) : undefined);
    }

    const plan = planScriptSync(shipped, installed, entry, options.mode === 'install');
    result.keptEdited.push(...plan.keptEdited);

    if (plan.write.length > 0 || plan.remove.length > 0) {
      const staging = await fs.mkdtemp(path.join(options.tempDir, 'vk-scripts-'));
      try {
        let sourceFiles: Map<string, string> = new Map();
        if (plan.write.length > 0) {
          if (source === HYBRID_SCRIPTS_SOURCE) {
            options.onProgress?.('Downloading VapourSynth scripts...');
            const zip = path.join(staging, 'hybrid.zip');
            await options.download(HYBRID_SCRIPTS_URL, zip);
            options.onProgress?.('Extracting VapourSynth scripts...');
            await options.unpack(zip, path.join(staging, 'extracted'));
            sourceFiles = await hybridScriptFiles(path.join(staging, 'extracted'));
          } else {
            options.onProgress?.(`Extracting ${source}...`);
            await options.unpack(path.join(options.bundledScriptsDir, source), path.join(staging, 'extracted'));
            for (const relative of await listFilesRecursive(path.join(staging, 'extracted'))) {
              sourceFiles.set(relative, path.join(staging, 'extracted', ...relative.split('/')));
            }
          }
        }

        for (const file of plan.write) {
          const from = sourceFiles.get(file);
          if (!from) throw new Error(`${source} does not contain ${file}`);
          const target = path.join(options.scriptsDir, ...file.split('/'));
          const current = installed.get(file);
          if (current !== undefined && current !== entry?.files[file]) {
            // A reinstall replacing an edit, or a file nothing says is ours:
            // keep the user's copy.
            await fs.copy(target, path.join(options.backupDir, ...file.split('/')), { overwrite: true });
          }
          await fs.copy(from, target, { overwrite: true });
          // The bytes actually written, in case the source drifted from the manifest.
          plan.files[file] = await sha256File(target);
          result.updated.push(file);
        }
        for (const file of plan.remove) {
          await fs.remove(path.join(options.scriptsDir, ...file.split('/')));
          result.removed.push(file);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`Could not update ${source} in vs-scripts:`, error);
        result.failed.push({ source, error: message });
        continue;
      } finally {
        await fs.remove(staging).catch(() => undefined);
      }
    }

    options.ledger[source] = { version: shipped.version, appVersion: options.appVersion, files: plan.files };
  }

  return result;
}

/**
 * The script sources whose installed version is not the one this build ships.
 *
 * Launch syncs scripts on an app version change, but builds can share a
 * version - nightlies rebuilt the same day all read 2.1.0-nightly.<date> - and
 * one of them can still ship a changed archive. Comparing the ledger with the
 * manifest costs nothing, where a sync hashes every installed script. A source
 * with no ledger entry counts as stale, so an install that has scripts but
 * predates the ledger gets one written.
 */
export function staleScriptSources(
  ledgerScripts: Readonly<Record<string, { version: string }>>,
  manifest: Readonly<Record<string, { version: string }>> = SCRIPT_SOURCE_MANIFEST,
): string[] {
  return Object.keys(manifest).filter(source => ledgerScripts[source]?.version !== manifest[source].version);
}

/**
 * Syncs this install's vs-scripts against the ledger and records the result.
 * `install` is plugin install and Reinstall; `update` is launch after an app
 * update, which never overwrites an edit.
 */
export async function syncInstalledScripts(
  mode: 'install' | 'update',
  onProgress?: (message: string) => void,
): Promise<ScriptSyncResult> {
  const ledger = await readLedger();
  const result = await syncScriptSources({
    scriptsDir: PATHS.SCRIPTS,
    bundledScriptsDir: path.join(getBundledBasePath(), 'include', 'scripts'),
    backupDir: path.join(PATHS.CONFIG, 'script-backups', `before-${app.getVersion()}`),
    tempDir: os.tmpdir(),
    appVersion: app.getVersion(),
    mode,
    ledger: ledger.scripts,
    download: (url, dest) => downloadToFile(url, dest, { label: 'VapourSynth scripts', minBytes: 1024 }),
    unpack: async (archive, into) => { await _7z.unpack(archive, into); },
    onProgress,
  });
  await writeLedger(ledger);

  for (const failure of result.failed) {
    logger.warn(`vs-scripts source ${failure.source} was not updated (retried next time): ${failure.error}`);
  }
  if (result.keptEdited.length > 0) {
    logger.info(`Kept edited vs-scripts: ${result.keptEdited.join(', ')}`);
  }
  return result;
}
