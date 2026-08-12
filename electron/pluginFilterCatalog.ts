/**
 * Platform policy for the bundled plugin-filter catalog.
 *
 * The Windows installer ships the native DLL/plugin archive that the complete
 * catalog was authored against, so Windows deliberately receives every
 * template. Linux instead installs its runtime from PyPI. Only templates whose
 * dependencies are supplied by that Linux install belong in its catalog.
 *
 * When adding an entry here, verify both the Python import and its native
 * VapourSynth plugin are provided by getPypiPackages()/vsjetpack on Linux.
 * Templates that depend on `hybrid_filters`, a bundled script archive, CUDA
 * only binaries, or another uninstalled native plugin must stay Windows-only
 * until their dependency is part of the Linux setup and has a smoke test.
 */

/**
 * Linux-safe plugin filters, grouped by the package that makes them available.
 * The names are source filenames, not user template names, so a custom template
 * with a different filename is never affected by this policy.
 */
export const LINUX_PLUGIN_FILTERS = {
  // VapourSynth core operations; no optional native plugin required.
  core: [
    'Assume FPS.vkfilter',
    'Blend Clips.vkfilter',
    'Clamp Values.vkfilter',
    'Delete Frames.vkfilter',
    'Duplicate Frames.vkfilter',
    'Expression.vkfilter',
    'Flip Horizontal.vkfilter',
    'Flip Vertical.vkfilter',
    'Frame Number.vkfilter',
    'Freeze Frame.vkfilter',
    'Interleave Clips.vkfilter',
    'Invert.vkfilter',
    'Levels.vkfilter',
    'Loop Clip.vkfilter',
    'Move Original Clip Reference.vkfilter',
    'Replace Frames.vkfilter',
    'Replace Multiple Frames.vkfilter',
    'Reverse Clip.vkfilter',
    'Select Every.vkfilter',
    'Side by Side.vkfilter',
    'Splice Clips.vkfilter',
    'Stack Horizontal.vkfilter',
    'Stack Vertical.vkfilter',
    'Text Overlay.vkfilter',
    'Transpose.vkfilter',
    'Turn 180.vkfilter',
  ],

  // vsjetpack[full,cl,vulkan] (or its vendor-specific equivalent).
  vsjetpack: [
    'AA EEDI3.vkfilter',
    'AA SangNom.vkfilter',
    'Based AA.vkfilter',
    'Bilateral.vkfilter',
    'Binarize Mask.vkfilter',
    'Blank Clip.vkfilter',
    'Box Blur.vkfilter',
    'Clense.vkfilter',
    'Contra Sharpening.vkfilter',
    'Convolution.vkfilter',
    'Deband.vkfilter',
    'Deblock.vkfilter',
    'Dehalo Alpha.vkfilter',
    'Deinterlace BWDIF.vkfilter',
    'Detail Mask.vkfilter',
    'Difference Mask.vkfilter',
    'Farid Edge Mask.vkfilter',
    'Fast Line Darken.vkfilter',
    'FDoG Edge Mask.vkfilter',
    'Fine Dehalo.vkfilter',
    'Fine Dehalo2.vkfilter',
    'Fine Sharp.vkfilter',
    'Flux Smooth.vkfilter',
    'FreyChen Edge Mask.vkfilter',
    'Gauss Blur.vkfilter',
    'Grain Stabilize.vkfilter',
    'Guided Filter.vkfilter',
    'Limit Filter.vkfilter',
    'Luma Mask.vkfilter',
    'Maximum.vkfilter',
    'Maximum then Minimum.vkfilter',
    'MC_Degrain _Advanced_.vkfilter',
    'MC_Degrain _Simple_.vkfilter',
    'Median Blur.vkfilter',
    'Minimum.vkfilter',
    'Minimum then Maximum.vkfilter',
    'NLM Denoise.vkfilter',
    'NNEDI3.vkfilter',
    'Normalize Mask.vkfilter',
    'Prewitt Edge Mask.vkfilter',
    'QTGMC _New_.vkfilter',
    'Ridge Mask.vkfilter',
    'SBR Sharpening.vkfilter',
    'Scharr Edge Mask.vkfilter',
    'Scene Change Detection.vkfilter',
    'Set Frame Props.vkfilter',
    'Shift Clip.vkfilter',
    'Sobel Edge Mask.vkfilter',
    'Trim Clip.vkfilter',
    'Unsharp Mask.vkfilter',
    'VIVTC.vkfilter',
    'Warp Sharp.vkfilter',
  ],

  // Explicit PyPI dependencies installed by getPypiPackages().
  pypi: [
    'Average Color Fix.vkfilter',       // vs_colorfix
    'Crop.vkfilter',                    // vs_tiletools
    'DPIR Denoise_Deblock.vkfilter',    // vapoursynth-mlrt-ncnn
    'FGrain.vkfilter',                  // vs_grain
    'Modulus.vkfilter',                 // vs_tiletools
    'Pad.vkfilter',                     // vs_tiletools
    'RIFE.vkfilter',                    // vs_tiletools + vapoursynth-mlrt-ncnn
    'Temporal Pad _Extend_.vkfilter',   // vs_tiletools
    'TemporalFix _AI_.vkfilter',        // vs_temporalfix (CPU fallback on Linux)
    'TemporalFix _Classic_.vkfilter',   // vs_temporalfix
    'Tile.vkfilter',                    // vs_tiletools
    'Undistort _Pytorch_.vkfilter',     // vs_undistort + CPU/CUDA PyTorch fallback
    'Undistort _TensorRT_.vkfilter',    // vs_undistort + existing CPU/TensorRT fallback
    'Untile.vkfilter',                  // vs_tiletools
    'Wavelet Color Fix.vkfilter',       // vs_colorfix + NCNN
  ],

  // The app extracts these Python scripts from extra_scripts.7z and installs
  // their CPU PyTorch dependencies on Linux. Keep this group separate from
  // PyPI so its archive dependency stays visible during future reviews.
  bundledScripts: [
    'Deep Deinterlace.vkfilter',        // vs_deepdeinterlace + torch
  ],
} as const;

/**
 * Bump this when the Linux allowlist or its synchronization behavior changes.
 * Nightly builds can share an Electron app version, so appVersion alone cannot
 * tell an existing installation that its bundled catalog needs reconciliation.
 */
export const LINUX_PLUGIN_FILTER_CATALOG_REVISION = 2;

const LINUX_PLUGIN_FILTER_SET = new Set<string>(Object.values(LINUX_PLUGIN_FILTERS).flat());

/** Select source filenames suitable for the target platform. */
export function selectPluginFilterTemplates(
  sourceFiles: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === 'win32') {
    return [...sourceFiles];
  }
  if (platform === 'linux') {
    return sourceFiles.filter(file => LINUX_PLUGIN_FILTER_SET.has(file));
  }
  return [];
}

/** Whether the native platform has any supported plugin-filter catalog. */
export function hasPluginFilterTemplates(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'linux';
}

/** Whether a Linux installation needs its bundled catalog reconciled. */
export function needsLinuxPluginFilterCatalogSync(
  storedRevision: number | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'linux' && storedRevision !== LINUX_PLUGIN_FILTER_CATALOG_REVISION;
}

/** The templates Linux must remove only when they still equal their bundled source. */
export function selectUnsupportedLinuxPluginFilterTemplates(sourceFiles: readonly string[]): string[] {
  return sourceFiles.filter(file => !LINUX_PLUGIN_FILTER_SET.has(file));
}
