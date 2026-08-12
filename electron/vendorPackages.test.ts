import { describe, it, expect, vi } from 'vitest';

// vendorPackages transitively imports constants.ts (directly and through the
// provider registry), which reads app paths at module scope.
vi.mock('electron', async () => {
  const p = await import('path');
  const o = await import('os');
  const root = p.join(o.tmpdir(), `vk-vendorpkg-test-${process.pid}`);
  return {
    app: {
      isPackaged: false,
      getAppPath: () => root,
      getPath: () => root,
    },
  };
});

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { GpuVendor } from './gpuDetection';
import {
  computeVendorPurge,
  evaluateInstallState,
  getBackendPipPackages,
  getBackendsForVendor,
  getCheckPackageNames,
  getPypiPackages,
  getTorchInstall,
  UNINSTALL_PACKAGE_NAMES,
} from './vendorPackages';

const NON_NVIDIA: GpuVendor[] = ['amd', 'intel', 'unknown'];

describe('getBackendsForVendor', () => {
  it('gives NVIDIA both TensorRT and DirectML', () => {
    expect(getBackendsForVendor('nvidia')).toEqual(['tensorrt', 'directml']);
  });

  it.each(NON_NVIDIA)('gives %s DirectML only', (vendor) => {
    expect(getBackendsForVendor(vendor)).toEqual(['directml']);
  });

  it('uses NCNN as the Linux default, retaining TensorRT as an NVIDIA option', () => {
    expect(getBackendsForVendor('nvidia', 'linux')).toEqual(['ncnn', 'tensorrt']);
    for (const vendor of NON_NVIDIA) {
      expect(getBackendsForVendor(vendor, 'linux')).toEqual(['ncnn']);
    }
  });
});

describe('getBackendPipPackages', () => {
  it('includes the mlrt-ort pin for every vendor', () => {
    for (const vendor of ['nvidia', ...NON_NVIDIA] as GpuVendor[]) {
      expect(getBackendPipPackages(vendor).some(spec => /^vapoursynth-mlrt-ort==/.test(spec))).toBe(true);
    }
  });

  it('includes the mlrt-trt pin only on NVIDIA', () => {
    expect(getBackendPipPackages('nvidia').some(spec => spec.startsWith('vapoursynth-mlrt-trt=='))).toBe(true);
    for (const vendor of NON_NVIDIA) {
      expect(getBackendPipPackages(vendor).some(spec => spec.startsWith('vapoursynth-mlrt-trt'))).toBe(false);
    }
  });

  it('includes the NCNN wheel for Linux', () => {
    for (const vendor of ['nvidia', ...NON_NVIDIA] as GpuVendor[]) {
      expect(getBackendPipPackages(vendor, 'linux')).toContain('vapoursynth-mlrt-ncnn==15.16');
    }
  });
});

describe('getPypiPackages', () => {
  it('installs the NVIDIA vsjetpack extras and the CUDA-only extras on NVIDIA', () => {
    const packages = getPypiPackages('nvidia');
    expect(packages).toContain('vsjetpack[full,nvidia]');
    expect(packages).toContain('vs_colorfix[tensorrt]');
    expect(packages).toContain('vapoursynth-nlm-cuda');
  });

  it('installs the AMD vsjetpack extras and no TensorRT/CUDA entries on AMD', () => {
    const packages = getPypiPackages('amd');
    expect(packages).toContain('vsjetpack[full,amd]');
    expect(packages).toContain('vs_colorfix');
    expect(packages).not.toContain('vs_colorfix[tensorrt]');
    expect(packages).not.toContain('vapoursynth-nlm-cuda');
    expect(packages.some(spec => /tensorrt|cuda|nvidia/i.test(spec))).toBe(false);
  });

  it.each<GpuVendor>(['intel', 'unknown'])('uses the vendor-neutral vsjetpack extras on %s', (vendor) => {
    const packages = getPypiPackages(vendor);
    expect(packages).toContain('vsjetpack[full,cl,vulkan]');
    expect(packages).toContain('vs_colorfix');
    expect(packages).not.toContain('vapoursynth-nlm-cuda');
  });

  it('keeps the vendor-neutral packages for every vendor', () => {
    for (const vendor of ['nvidia', ...NON_NVIDIA] as GpuVendor[]) {
      const packages = getPypiPackages(vendor);
      expect(packages).toContain('vapoursynth');
      expect(packages).toContain('vs_temporalfix');
      expect(packages).toContain('vs_undistort');
      expect(packages).toContain('vs_grain');
      expect(packages).toContain('vapoursynth-mvtools');
      expect(packages).toContain('positional-encodings');
      expect(packages).toContain('einops');
      expect(packages).toContain('timm');
      // Backend wheels come from the providers, never from this list
      expect(packages.some(spec => spec.startsWith('vapoursynth-mlrt'))).toBe(false);
    }
  });
});

describe('getTorchInstall', () => {
  it('uses the CUDA wheel index on NVIDIA', () => {
    const install = getTorchInstall('nvidia');
    expect(install.packages).toEqual(['torch', 'torchvision']);
    expect(install.extraArgs).toEqual(['--index-url', 'https://download.pytorch.org/whl/cu130']);
  });

  it.each(NON_NVIDIA)('uses the default PyPI index (CPU wheels) on %s', (vendor) => {
    const install = getTorchInstall(vendor);
    expect(install.packages).toEqual(['torch', 'torchvision']);
    expect(install.extraArgs).toEqual([]);
  });
});

describe('getCheckPackageNames', () => {
  it('requires both backend wheels on NVIDIA', () => {
    const names = getCheckPackageNames('nvidia');
    expect(names).toContain('vapoursynth-mlrt-trt');
    expect(names).toContain('vapoursynth-mlrt-ort');
    expect(names).toContain('vapoursynth');
    expect(names).toContain('torch');
  });

  it.each(NON_NVIDIA)('requires only the ORT wheel on %s', (vendor) => {
    const names = getCheckPackageNames(vendor);
    expect(names).toContain('vapoursynth-mlrt-ort');
    expect(names).not.toContain('vapoursynth-mlrt-trt');
  });

  it('returns PEP 503-normalized names', () => {
    for (const name of getCheckPackageNames('nvidia')) {
      expect(name).toBe(name.toLowerCase());
      expect(name).not.toContain('_');
      expect(name).not.toMatch(/[[=<>]/);
    }
  });
});

describe('UNINSTALL_PACKAGE_NAMES', () => {
  it('lists vendor-neutral dist names only (no extras, no pins)', () => {
    expect(UNINSTALL_PACKAGE_NAMES).toContain('torch');
    expect(UNINSTALL_PACKAGE_NAMES).toContain('vsjetpack');
    for (const name of UNINSTALL_PACKAGE_NAMES) {
      expect(name).not.toMatch(/[[=<>]/);
    }
  });
});

describe('evaluateInstallState', () => {
  it('reports not installed when packages are missing', () => {
    expect(evaluateInstallState('nvidia', 'nvidia', ['vsjetpack'])).toEqual({
      installed: false,
      reason: 'missing-packages',
    });
  });

  it('reports a vendor mismatch when the installed set targets another vendor', () => {
    expect(evaluateInstallState('nvidia', 'amd', [])).toEqual({
      installed: false,
      reason: 'vendor-mismatch',
    });
    expect(evaluateInstallState('amd', 'nvidia', [])).toEqual({
      installed: false,
      reason: 'vendor-mismatch',
    });
  });

  it('backfills NVIDIA for installs predating vendor tracking', () => {
    expect(evaluateInstallState('nvidia', undefined, [])).toEqual({
      installed: true,
      backfillVendor: 'nvidia',
      reason: 'ok',
    });
  });

  it.each(NON_NVIDIA)('reports legacy installs on %s as not installed (no backfill)', (vendor) => {
    const state = evaluateInstallState(vendor, undefined, []);
    expect(state.installed).toBe(false);
    expect(state.reason).toBe('legacy-non-nvidia');
    expect(state.backfillVendor).toBeUndefined();
  });

  it('reports a matching, complete install as installed', () => {
    for (const vendor of ['nvidia', ...NON_NVIDIA] as GpuVendor[]) {
      expect(evaluateInstallState(vendor, vendor, [])).toEqual({ installed: true, reason: 'ok' });
    }
  });

  it('prefers the missing-packages reason over a vendor mismatch', () => {
    expect(evaluateInstallState('amd', 'nvidia', ['vsjetpack']).reason).toBe('missing-packages');
  });
});

describe('computeVendorPurge', () => {
  const cudaStack = [
    { name: 'tensorrt', version: '10.13.0' },
    { name: 'tensorrt-cu13', version: '10.13.0' },
    { name: 'tensorrt-rtx-cu13', version: '10.13.0' },
    { name: 'nvidia-cudnn-cu13', version: '9.8.0' },
    { name: 'vapoursynth-mlrt-trt', version: '16.1' },
    { name: 'vapoursynth-mlrt-ort-cuda', version: '16.1' },
    { name: 'vapoursynth-mlrt-ort', version: '16.1' },
    { name: 'vapoursynth-nlm-cuda', version: '1.0' },
    { name: 'vapoursynth', version: '79' },
  ];

  it('purges the CUDA/TensorRT stack on AMD but never the plain ORT wheel', () => {
    const purge = computeVendorPurge('amd', cudaStack);
    expect(purge).toContain('tensorrt-cu13');
    expect(purge).toContain('tensorrt-rtx-cu13');
    expect(purge).toContain('nvidia-cudnn-cu13');
    expect(purge).toContain('vapoursynth-mlrt-trt');
    expect(purge).toContain('vapoursynth-mlrt-ort-cuda');
    expect(purge).toContain('vapoursynth-nlm-cuda');
    expect(purge).not.toContain('vapoursynth-mlrt-ort');
    expect(purge).not.toContain('vapoursynth');
  });

  it('keeps the CUDA stack on NVIDIA', () => {
    expect(computeVendorPurge('nvidia', cudaStack)).toEqual([]);
  });

  it('purges the HIP plugins off AMD (including the hiprtc variant)', () => {
    const hipStack = [
      { name: 'vapoursynth-bm3dhip', version: '1.0' },
      { name: 'vapoursynth-dfttest2-hip', version: '1.0' },
      { name: 'vapoursynth-dfttest2-hiprtc', version: '1.0' },
      { name: 'vapoursynth-mlrt-migx', version: '16.1' },
    ];
    const purge = computeVendorPurge('nvidia', hipStack);
    expect(purge).toEqual([
      'vapoursynth-bm3dhip',
      'vapoursynth-dfttest2-hip',
      'vapoursynth-dfttest2-hiprtc',
      'vapoursynth-mlrt-migx',
    ]);
    expect(computeVendorPurge('amd', hipStack)).toEqual([]);
  });

  it('normalizes installed names before matching', () => {
    expect(computeVendorPurge('amd', [{ name: 'NVIDIA_cuDNN_cu13', version: '9.8.0' }]))
      .toEqual(['nvidia-cudnn-cu13']);
  });

  it('purges a CUDA torch on a non-NVIDIA machine', () => {
    const purge = computeVendorPurge('amd', [
      { name: 'torch', version: '2.9.0+cu130' },
      { name: 'torchvision', version: '0.24.0+cu130' },
    ]);
    expect(purge).toContain('torch');
    expect(purge).toContain('torchvision');
  });

  it('purges a CPU torch on an NVIDIA machine', () => {
    const purge = computeVendorPurge('nvidia', [
      { name: 'torch', version: '2.9.0' },
      { name: 'torchvision', version: '0.24.0' },
    ]);
    expect(purge).toEqual(['torch', 'torchvision']);
  });

  it('leaves a matching torch flavor alone in both directions', () => {
    expect(computeVendorPurge('nvidia', [{ name: 'torch', version: '2.9.0+cu130' }])).toEqual([]);
    expect(computeVendorPurge('amd', [{ name: 'torch', version: '2.9.0' }])).toEqual([]);
  });

  it('returns nothing for an empty environment', () => {
    expect(computeVendorPurge('unknown', [])).toEqual([]);
  });

  it('never lists the same package twice', () => {
    const purge = computeVendorPurge('intel', [
      { name: 'torch', version: '2.9.0+cu130' },
      { name: 'torchvision', version: '0.24.0+cu130' },
      { name: 'tensorrt-cu13', version: '10.13.0' },
    ]);
    expect(new Set(purge).size).toBe(purge.length);
  });
});
