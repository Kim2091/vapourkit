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
