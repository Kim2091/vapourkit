/**
 * The legacy bundled `plugins.7z` contains Windows VapourSynth binaries.
 * Linux obtains native plugins from platform-specific PyPI wheels instead.
 */
export function shouldExtractBundledPluginArchives(
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === 'win32';
}

/** The companion plugin_filters catalog depends on the Windows native bundle. */
export function shouldCopyBundledPluginFilterTemplates(
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === 'win32';
}
