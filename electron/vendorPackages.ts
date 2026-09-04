// electron/vendorPackages.ts
//
// Everything vendor-specific about the Python package install that is NOT a
// backend. The inference backends themselves stay the source of truth for their
// own wheels (electron/providers/*/pipPackages()); this module only decides
// WHICH backends a machine gets (getBackendsForVendor) plus the torch flavor,
// the vsjetpack extras, the CUDA-only extras, the check-name list, and the
// purge of packages belonging to a different vendor.
//
// Pure functions only — no electron API calls at call time, so the install,
// check and uninstall paths can all share (and tests can exercise) them.

import { VSVIEW_MIN_VERSION } from './constants';
import type { GpuVendor } from './gpuDetection';
import { getProvider, type BackendId } from './providers/registry';

/** PEP 503 name normalization: lowercase, underscores mapped to dashes. */
export function normalizePackageName(name: string): string {
  return name.trim().toLowerCase().replace(/_/g, '-');
}

/** Normalized distribution name of a pip requirement spec ("vsjetpack[full]>=1" → "vsjetpack"). */
function distNameOf(spec: string): string {
  return normalizePackageName(spec.split(/[[<>=!~;\s]/)[0]);
}

/**
 * The bridge to the provider registry: which inference backends this vendor
 * gets installed. When another provider lands, extending vendor support is a
 * one-array edit here.
 */
export function getBackendsForVendor(vendor: GpuVendor, platform: NodeJS.Platform = process.platform): BackendId[] {
  if (platform === 'linux') {
    // DirectML is Windows-only. NCNN/Vulkan is the Linux default for every
    // GPU vendor; NVIDIA users additionally receive TensorRT as an option.
    return vendor === 'nvidia' ? ['ncnn', 'tensorrt'] : ['ncnn'];
  }
  if (platform === 'win32') {
    // NCNN is also available on Windows, giving every Windows GPU vendor a
    // Vulkan option alongside DirectML. NVIDIA retains TensorRT as its fastest
    // backend.
    return vendor === 'nvidia' ? ['tensorrt', 'directml', 'ncnn'] : ['directml', 'ncnn'];
  }
  // macOS and other platforms are not supported yet; never treat them as Linux.
  return [];
}

/** pip specs for every backend this vendor gets (composed from the providers). */
export function getBackendPipPackages(vendor: GpuVendor, platform: NodeJS.Platform = process.platform): string[] {
  return getBackendsForVendor(vendor, platform).flatMap(id => getProvider(id).pipPackages());
}

export interface TorchInstall {
  packages: string[];
  extraArgs: string[];
}

/**
 * PyTorch is only needed by the bundled (non-PyPI) vs_deepdeinterlace scripts.
 * NVIDIA gets the CUDA wheels; every other vendor gets CPU wheels from the
 * default PyPI index — slow but importable, which keeps the bundled filter
 * templates working instead of silently breaking them.
 */
export function getTorchInstall(vendor: GpuVendor): TorchInstall {
  return {
    packages: ['torch', 'torchvision'],
    extraArgs: vendor === 'nvidia'
      ? ['--index-url', 'https://download.pytorch.org/whl/cu130']
      : [],
  };
}

/**
 * vsjetpack extras per vendor. `[full,nvidia]` pulls the CUDA plugin builds;
 * `[full,amd]` transitively includes gpu/cl/vulkan plus the HIP denoise
 * plugins; `[full,cl,vulkan]` is the vendor-neutral baseline (DirectML
 * inference still works — the directml provider pins mlrt-ort explicitly).
 */
function getVsJetpackSpec(vendor: GpuVendor): string {
  switch (vendor) {
    case 'nvidia':
      return 'vsjetpack[full,nvidia]';
    case 'amd':
      return 'vsjetpack[full,amd]';
    default:
      return 'vsjetpack[full,cl,vulkan]';
  }
}

/**
 * The VapourSynth ecosystem installed from PyPI, minus the inference backend
 * wheels (those come from getBackendPipPackages, so the vs-mlrt pins live in
 * the provider modules only).
 */
export function getPypiPackages(vendor: GpuVendor): string[] {
  const isNvidia = vendor === 'nvidia';
  return [
    'vapoursynth',
    getVsJetpackSpec(vendor),
    `vsview[full]>=${VSVIEW_MIN_VERSION}`,
    'vs_temporalfix',
    'vs_undistort',
    'vs_grain',
    // Only a .dev release exists on PyPI so far; a bare name would not match it
    'vs_tiletools>=1.0.0.dev0',
    // The tensorrt extra is CUDA-only; the plain package works everywhere else
    isNvidia ? 'vs_colorfix[tensorrt]' : 'vs_colorfix',
    // API4 rebuilds of plugins whose bundled copies were API3-only —
    // VapourSynth R79 aborts on API3 plugins, so these come from PyPI now
    'vapoursynth-mvtools',
    'vapoursynth-cas',
    'vapoursynth-adaptivegrain',
    'vapoursynth-wnnm',
    // KNLMeansCL's CUDA build. Off NVIDIA the "NLM Denoise" template runs on
    // nlm-ispc (shipped by vsjetpack's denoise extra, part of [full]); only the
    // "NLM Denoise _CUDA_" template is NVIDIA-only.
    ...(isNvidia ? ['vapoursynth-nlm-cuda'] : []),
    'vapoursynth-scxvid',
    'vapoursynth-dctfilter',
    // Applies 3D LUTs for the "Apply LUT" template. Without it that filter
    // still works, but falls back to a table built out of akarin.Expr which
    // has to carry the table as a companion clip the size of the picture.
    // Measured, per 24 frames:
    //
    //          timecube            akarin fallback     no LUT step
    //   1080p  185 fps  +524MB      43 fps  +1060MB     +523MB
    //   4K      43 fps +2091MB      10 fps  +4192MB    +2089MB
    //
    // So timecube costs nothing over the pipeline's own baseline, where the
    // fallback doubles it. Both agree to 1.2e-7 on the same cube, because
    // timecube's default interpolation is trilinear like ours; its interp=1
    // is tetrahedral and deliberately not used, or the render would change
    // depending on which plugin happened to be installed.
    'vapoursynth-timecube',
    // Needed by the bundled (non-PyPI) vs_deepdeinterlace scripts
    'positional-encodings',
    'einops',
    'timm',
  ];
}

/**
 * Vendor-neutral packages checkInstalled looks for, normalized (PEP 503) for
 * comparison against `pip list` output.
 */
const BASE_CHECK_PACKAGE_NAMES: string[] = [
  'vapoursynth', 'torch', 'vsjetpack', 'vsview',
  'vs-temporalfix', 'vs-undistort', 'vs-colorfix', 'vs-grain', 'vs-tiletools',
];

/**
 * Package names that must be present for this vendor's install to count as
 * complete. The backend wheels are derived from the providers rather than
 * hardcoded, so moving an AMD install to an NVIDIA machine reads as
 * not-installed (the TRT wheel is missing) and offers a reinstall.
 */
export function getCheckPackageNames(vendor: GpuVendor, platform: NodeJS.Platform = process.platform): string[] {
  return [
    ...BASE_CHECK_PACKAGE_NAMES.map(normalizePackageName),
    ...getBackendPipPackages(vendor, platform).map(distNameOf),
  ];
}

/**
 * Packages uninstallDependencies removes. Deliberately NOT vendor-branched:
 * every name here is a vendor-neutral distribution name (extras like
 * `[full,nvidia]` never change the dist name pip sees), and `pip uninstall -y`
 * skips absent packages with a warning and exit code 0. So the one shared list
 * is correct for every vendor and removes exactly the same top-level set it
 * always has. Please don't "fix" this by adding vendor branches.
 *
 * The core runtime (vapoursynth, vapoursynth-bestsource, vs-mlrt) is
 * intentionally left installed so the app itself keeps working.
 */
export const UNINSTALL_PACKAGE_NAMES: string[] = [
  'torch', 'torchvision', 'positional-encodings', 'einops', 'timm',
  'vsjetpack', 'vsview',
  'vs-temporalfix', 'vs-undistort', 'vs-colorfix', 'vs-grain', 'vs-tiletools',
];

export type InstallStateReason = 'ok' | 'missing-packages' | 'vendor-mismatch' | 'legacy-non-nvidia';

export interface InstallState {
  installed: boolean;
  /** When set, the caller should persist this as the installed set's vendor. */
  backfillVendor?: GpuVendor;
  reason: InstallStateReason;
}

/**
 * The decision core of checkInstalled, extracted so the mismatch/backfill rules
 * are testable without spawning pip.
 *
 * `pluginsGpuVendor === undefined` means the install predates vendor tracking.
 * Every 0.17.0 install was CUDA-flavored, so an NVIDIA machine is grandfathered
 * in (backfill, no forced reinstall) while amd/intel/unknown deliberately read
 * as not-installed: their package set genuinely mismatches the machine and a
 * reinstall is the remediation they need. On AMD every name in the check list
 * passes, so this rule is the only thing that catches those users.
 */
export function evaluateInstallState(
  vendor: GpuVendor,
  pluginsGpuVendor: GpuVendor | undefined,
  missingNames: string[]
): InstallState {
  if (missingNames.length > 0) {
    return { installed: false, reason: 'missing-packages' };
  }

  if (pluginsGpuVendor === undefined) {
    if (vendor === 'nvidia') {
      return { installed: true, backfillVendor: 'nvidia', reason: 'ok' };
    }
    return { installed: false, reason: 'legacy-non-nvidia' };
  }

  if (pluginsGpuVendor !== vendor) {
    return { installed: false, reason: 'vendor-mismatch' };
  }

  return { installed: true, reason: 'ok' };
}

/**
 * Installed-package name prefixes belonging to the CUDA/TensorRT stack.
 *
 * Prefix matching is deliberate: it covers `tensorrt-cu13`, `tensorrt-rtx-cu13`,
 * `nvidia-cudnn-cu13`, ... without hardcoding every dist name. The match
 * direction is installedName.startsWith(prefix), which is what makes
 * `vapoursynth-mlrt-ort-cuda` safe to list — plain `vapoursynth-mlrt-ort` is
 * shorter than the prefix and therefore never matches it.
 */
const NVIDIA_ONLY_PREFIXES: string[] = [
  'tensorrt',
  'nvidia-',
  'vapoursynth-mlrt-trt',
  'vapoursynth-mlrt-ort-cuda',
  'vapoursynth-bm3dcuda',
  'vapoursynth-bilateralgpu',
  'vapoursynth-vszipcu',
  'vapoursynth-nlm-cuda',
  'vapoursynth-dfttest2-cuda',
];

/** ROCm/HIP plugin prefixes only an AMD install should carry. */
const AMD_ONLY_PREFIXES: string[] = [
  'vapoursynth-bm3dhip',
  // also covers vapoursynth-dfttest2-hiprtc
  'vapoursynth-dfttest2-hip',
  'vapoursynth-mlrt-migx',
];

export interface InstalledPackage {
  name: string;
  version: string;
}

/**
 * Installed packages that belong to a different GPU vendor than `vendor`,
 * computed fresh from `pip list` on every install run (never from stored
 * state). Removing them is not optional: pip treats `torch 2.x+cu130` as
 * satisfying `torch` so the flavor switch would never happen, a leftover
 * ort-cuda plugin folder wins the autoload race over plain ort, and the
 * CUDA/TensorRT stack is multi-GB of dead weight off NVIDIA.
 */
export function computeVendorPurge(vendor: GpuVendor, installed: InstalledPackage[]): string[] {
  const prefixes: string[] = [];
  if (vendor !== 'nvidia') {
    prefixes.push(...NVIDIA_ONLY_PREFIXES);
  }
  if (vendor !== 'amd') {
    prefixes.push(...AMD_ONLY_PREFIXES);
  }

  const purge: string[] = [];
  const seen = new Set<string>();
  const add = (name: string) => {
    if (!seen.has(name)) {
      seen.add(name);
      purge.push(name);
    }
  };

  for (const pkg of installed) {
    const name = normalizePackageName(pkg.name);
    if (prefixes.some(prefix => name.startsWith(prefix))) {
      add(name);
    }
  }

  // Torch flavor rule: a +cuXXX local version on a non-NVIDIA machine (or a
  // plain CPU wheel on an NVIDIA one) must be uninstalled before the correct
  // flavor can be installed, because pip considers both to satisfy "torch".
  const torch = installed.find(pkg => normalizePackageName(pkg.name) === 'torch');
  if (torch && torch.version.includes('+cu') !== (vendor === 'nvidia')) {
    add('torch');
    add('torchvision');
  }

  return purge;
}
