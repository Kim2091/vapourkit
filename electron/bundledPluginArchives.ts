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
 * by content on every app update instead.
 */
export const APP_OWNED_PLUGIN_ARCHIVES: readonly string[] = ['vsdlssnr.7z'];

/**
 * The plugin-filter catalog is plain text and works independently of the
 * Windows-only native archive. Individual templates may still require an
 * optional plugin, just as they do on Windows, but the catalog must be
 * available to every supported desktop build.
 */
export function shouldCopyBundledPluginFilterTemplates(
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === 'win32' || platform === 'linux';
}
