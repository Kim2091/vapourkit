// electron/scriptSources.ts
//
// Where the Python modules in vs-scripts come from. Each source has a version,
// and scriptSourceManifest.ts (generated) records every file each version
// ships, so an update can tell which installed scripts are ours and current,
// ours and stale, or edited by the user - see scriptSync.ts.

/**
 * Selur's VapoursynthScriptsInHybrid, pinned to a commit: the Hybrid scripts
 * several bundled filters import (havsfunc and friends). Changing this means
 * regenerating the manifest - `npx tsx scripts/generateScriptManifest.ts` -
 * which a test enforces.
 */
export const HYBRID_SCRIPTS_COMMIT = 'd430e1973a78c2dc52a6e4aa58e5f89cc0093ae9';
export const HYBRID_SCRIPTS_URL = `https://github.com/Selur/VapoursynthScriptsInHybrid/archive/${HYBRID_SCRIPTS_COMMIT}.zip`;

/** The id the ledger and manifest key the Hybrid scripts by. */
export const HYBRID_SCRIPTS_SOURCE = 'hybrid-scripts';

/**
 * Archives in include/scripts extracted into vs-scripts, keyed by filename.
 * Their version is the archive's own sha256, so a rebuilt archive is a new
 * version without anyone having to remember to bump anything.
 */
export const BUNDLED_SCRIPT_ARCHIVES: readonly string[] = ['extra_scripts.7z'];

/**
 * Python modules from the old bundled extra_scripts.7z that are now installed
 * from PyPI. vs-scripts is on the import path, so stale copies here would shadow
 * the pip-installed packages in site-packages. Both sources still carry some of
 * them, so plugin install deletes them after extracting, and the manifest and
 * the sync leave them out - or every update would put the shadows back.
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

/** Whether a path under vs-scripts belongs to a module PyPI now provides. */
export function isSupersededScript(file: string): boolean {
  return SUPERSEDED_SCRIPT_MODULES.includes(file.split('/')[0]);
}

export interface ScriptSourceManifestEntry {
  /** The commit for a download, the archive sha256 for a bundled archive */
  version: string;
  /** Path under vs-scripts, with forward slashes, to the sha256 of its bytes */
  files: Readonly<Record<string, string>>;
}
