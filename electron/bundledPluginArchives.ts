import * as path from 'path';
import * as fs from 'fs-extra';
import type { PluginLedgerEntry } from './installLedger';

/**
 * The legacy bundled `plugins.7z` contains Windows VapourSynth binaries.
 * Linux obtains native plugins from platform-specific PyPI wheels instead.
 */
export function shouldExtractBundledPluginArchives(
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === 'win32';
}

/**
 * Archives holding plugins built in this repo, which no pip wheel shares a
 * filename with. Plugin install extracts every archive skip-existing so it
 * cannot clobber a pip-managed DLL, but that also means a rebuilt plugin of
 * our own never replaces the copy an install already has. These are refreshed
 * by content on every app update instead, and an archive dropped from this
 * list has its files removed.
 */
export const APP_OWNED_PLUGIN_ARCHIVES: readonly string[] = [];

/**
 * Removes the files of every ledger archive that is no longer in `shipped`,
 * and drops its entry. An archive whose files could not be removed keeps its
 * entry, so the next update tries again. Returns the archives retired.
 */
export async function retireDroppedPluginArchives(
  plugins: Record<string, PluginLedgerEntry>,
  pluginsDir: string,
  shipped: readonly string[] = APP_OWNED_PLUGIN_ARCHIVES
): Promise<string[]> {
  const retired: string[] = [];
  for (const [archive, entry] of Object.entries(plugins)) {
    if (shipped.includes(archive)) continue;
    try {
      for (const file of entry.files) await fs.remove(path.join(pluginsDir, file));
    } catch {
      continue;
    }
    delete plugins[archive];
    retired.push(archive);
  }
  return retired;
}
