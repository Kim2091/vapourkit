// electron/gpuDetection.ts
//
// GPU vendor probe. Kept separate from utils.ts because it owns one concern and
// has no configManager dependency — persisting the result is the caller's job.
// A Linux `lspci` fallback (if the Electron probe ever proves insufficient)
// slots into this one file.
//
// nvidia-smi is the authoritative NVIDIA signal: a 0x10DE device without a
// working driver cannot run CUDA/TensorRT anyway, so it must not be reported as
// 'nvidia'. Everything else is resolved from Electron's own GPU info, which
// needs no child process and works cross-platform.

import { logger } from './logger';
import { probeNvidiaSmi, type NvidiaSmiResult } from './utils';

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'unknown';

const GPU_VENDORS: readonly GpuVendor[] = ['nvidia', 'amd', 'intel', 'unknown'];

/** PCI vendor IDs of the GPU vendors we install different package sets for. */
const PCI_VENDOR_IDS: Record<number, GpuVendor> = {
  0x10de: 'nvidia',
  0x1002: 'amd',
  0x8086: 'intel',
};

/**
 * Maps a PCI vendor ID to a GpuVendor. Anything unlisted is 'unknown' —
 * including 0x1414 (Microsoft Basic Render Driver), which is a software adapter
 * and deliberately must not be mistaken for a real GPU.
 */
export function mapPciVendorId(id: number): GpuVendor {
  return PCI_VENDOR_IDS[id] ?? 'unknown';
}

/** Multi-GPU preference: discrete/richest backend first. */
const VENDOR_PREFERENCE: readonly GpuVendor[] = ['nvidia', 'amd', 'intel'];

export function pickPreferredVendor(candidates: GpuVendor[]): GpuVendor {
  for (const vendor of VENDOR_PREFERENCE) {
    if (candidates.includes(vendor)) {
      return vendor;
    }
  }
  return 'unknown';
}

function isGpuVendor(value: unknown): value is GpuVendor {
  return typeof value === 'string' && (GPU_VENDORS as readonly string[]).includes(value);
}

const GPU_INFO_TIMEOUT_MS = 3000;

interface BasicGpuInfo {
  gpuDevice?: Array<{ vendorId?: number | string }>;
}

/**
 * Enumerates PCI vendor IDs through Electron's GPU info, raced against a
 * timeout (the GPU process can be dead or headless, in which case the promise
 * may never settle).
 */
async function probeGpuInfoVendors(): Promise<GpuVendor[]> {
  const { app } = require('electron');
  await app.whenReady();

  let timer: NodeJS.Timeout | undefined;
  try {
    const info = await Promise.race([
      app.getGPUInfo('basic') as Promise<unknown>,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`app.getGPUInfo timed out after ${GPU_INFO_TIMEOUT_MS}ms`)), GPU_INFO_TIMEOUT_MS);
      }),
    ]);

    const devices = (info as BasicGpuInfo)?.gpuDevice ?? [];
    return devices.map(device => mapPciVendorId(Number(device?.vendorId)));
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * The vendor from nvidia-smi's answer and the PCI devices present, given the
 * vendor recorded last time.
 *
 * nvidia-smi saying yes is NVIDIA. Otherwise an NVIDIA device only counts when
 * nvidia-smi could not answer (it timed out waking the GPU) or this machine was
 * NVIDIA last time (its driver failing once must not re-target every package
 * check at another vendor, which reads an installed setup as not installed).
 * A 0x10DE device that has never answered still falls through to the others.
 */
export function resolveGpuVendor(
  smi: NvidiaSmiResult,
  devices: GpuVendor[],
  previous?: GpuVendor,
): GpuVendor {
  if (smi === 'yes') return 'nvidia';
  if (devices.includes('nvidia') && (smi === 'timeout' || previous === 'nvidia')) return 'nvidia';
  return pickPreferredVendor(devices.filter(vendor => vendor !== 'nvidia'));
}

/**
 * Detects the GPU vendor this machine should install packages for.
 *
 * Order: env override → nvidia-smi → Electron GPU info → 'unknown' (the safe
 * DirectML baseline, which works on every Windows GPU). `previous` is the
 * vendor recorded last time, which a probe that learns nothing never replaces.
 */
export async function detectGpuVendor(previous?: GpuVendor): Promise<GpuVendor> {
  const override = process.env.VAPOURKIT_FORCE_GPU_VENDOR;
  if (isGpuVendor(override)) {
    logger.info(`*** VAPOURKIT_FORCE_GPU_VENDOR is set — GPU vendor forced to '${override}' ***`);
    return override;
  }
  if (override) {
    logger.warn(`Ignoring VAPOURKIT_FORCE_GPU_VENDOR='${override}' (expected one of ${GPU_VENDORS.join(', ')})`);
  }

  const smi = await probeNvidiaSmi();
  if (smi === 'yes') return 'nvidia';

  let devices: GpuVendor[];
  try {
    devices = await probeGpuInfoVendors();
  } catch (error) {
    logger.warn(`GPU probe failed/timed out: ${error instanceof Error ? error.message : String(error)}`);
    // Nothing learned: keep what we knew rather than retarget the packages.
    return previous && previous !== 'unknown' ? previous : 'unknown';
  }

  const vendor = resolveGpuVendor(smi, devices, previous);
  logger.info(`GPU vendor detected from Electron GPU info: ${vendor} (nvidia-smi: ${smi}, devices: ${devices.join(', ') || 'none'}${previous ? `, previously ${previous}` : ''})`);
  return vendor;
}
