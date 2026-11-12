// electron/gpuSelection.ts
//
// Which GPU inference runs on, for every backend.
//
// Each backend numbers GPUs in its own API: DirectML by DXGI adapter, NCNN by
// Vulkan device, TensorRT by CUDA device, MIGraphX by HIP device, and the
// orders differ. So the setting names one physical GPU, and include/vk_gpus.py
// finds its number in each API:
//   CUDA and HIP   pinned here, in every child environment, with
//                  CUDA_VISIBLE_DEVICES (the GPU's UUID) and HIP_VISIBLE_DEVICES,
//                  so TensorRT builds, vstrt, MIGraphX compiles, PyTorch filters
//                  and their child processes all see only that GPU
//   DXGI, Vulkan   looked up inside vspipe by vk_runtime (Windows can order
//                  adapters differently per process), and passed as device_id
// A GPU an API does not see leaves that backend on its default GPU.
//
// Imports nothing from configManager (which imports utils, which uses this);
// configManager pushes the setting in with setGpuChoice.

import { spawn } from 'child_process';
import * as path from 'path';
import { logger } from './logger';

/** One physical GPU as include/vk_gpus.py lists it. */
export interface GpuInfo {
  name: string;
  vendorId: number;
  deviceId: number;
  type: string | null;
  /** Adapter LUID as hex; Windows only, and new at every boot. */
  luid: string | null;
  /** PCI location, e.g. 0000:01:00.0, when a driver reports it. */
  pci: string | null;
  vramMB: number | null;
  /** The GPU's number in each API, null when that API does not see it. */
  dxgi: number | null;
  vulkan: number | null;
  cuda: number | null;
  /** The value CUDA_VISIBLE_DEVICES takes, e.g. GPU-dd374f64-... */
  cudaUuid: string | null;
  hip: number | null;
}

/** The chosen GPU as stored in the app config. */
export interface GpuChoice {
  name: string;
  vendorId: number;
  deviceId: number;
  /** Position among GPUs of the same model, for machines with two of one. */
  ordinal: number;
  pci?: string;
  luid?: string;
  cudaUuid?: string;
  hip?: number;
}

const GPU_ENV_KEYS = ['CUDA_VISIBLE_DEVICES', 'HIP_VISIBLE_DEVICES'] as const;

let current: GpuChoice | undefined;

export function setGpuChoice(choice: GpuChoice | undefined): void {
  current = choice;
}

export function getGpuChoice(): GpuChoice | undefined {
  return current;
}

function ordinalOf(gpus: GpuInfo[], gpu: GpuInfo): number {
  return gpus
    .filter(other => other.vendorId === gpu.vendorId && other.deviceId === gpu.deviceId)
    .indexOf(gpu);
}

/** The stored form of a listed GPU. */
export function choiceFor(gpus: GpuInfo[], gpu: GpuInfo): GpuChoice {
  return {
    name: gpu.name,
    vendorId: gpu.vendorId,
    deviceId: gpu.deviceId,
    ordinal: Math.max(ordinalOf(gpus, gpu), 0),
    ...(gpu.pci ? { pci: gpu.pci } : {}),
    ...(gpu.luid ? { luid: gpu.luid } : {}),
    ...(gpu.cudaUuid ? { cudaUuid: gpu.cudaUuid } : {}),
    ...(gpu.hip !== null ? { hip: gpu.hip } : {}),
  };
}

/**
 * The listed GPU a stored choice names: by PCI location, then model and
 * ordinal. LUIDs are not compared, since they change at every boot.
 */
export function findChosenGpu(gpus: GpuInfo[], choice: GpuChoice): GpuInfo | undefined {
  if (choice.pci) {
    const byPci = gpus.find(gpu => gpu.pci === choice.pci);
    if (byPci) return byPci;
  }
  return gpus.filter(gpu => gpu.vendorId === choice.vendorId && gpu.deviceId === choice.deviceId)[choice.ordinal];
}

/**
 * Applies the choice to a child environment in place. Leaves the environment
 * alone when no GPU is chosen, and leaves CUDA or HIP alone when the chosen
 * GPU is not a CUDA or HIP device, so those backends keep their default.
 */
export function applyGpuEnvironment(env: NodeJS.ProcessEnv, choice: GpuChoice | undefined = current): NodeJS.ProcessEnv {
  if (!choice) return env;
  if (choice.cudaUuid) env['CUDA_VISIBLE_DEVICES'] = choice.cudaUuid;
  if (choice.hip !== undefined) env['HIP_VISIBLE_DEVICES'] = String(choice.hip);
  return env;
}

/** The GPU variables applyGpuEnvironment sets, for environments a child builds from scratch. */
export function gpuEnvironmentEntries(choice: GpuChoice | undefined = current): Record<string, string> {
  const env = applyGpuEnvironment({}, choice);
  return Object.fromEntries(GPU_ENV_KEYS.flatMap(key => env[key] !== undefined ? [[key, env[key] as string]] : []));
}

/** The choice as the Python dict vk_runtime.configure() takes, or None. */
export function gpuScriptTarget(choice: GpuChoice | undefined = current): string {
  if (!choice) return 'None';
  const entries: [string, string | number][] = [
    ['name', choice.name], ['vendorId', choice.vendorId], ['deviceId', choice.deviceId], ['ordinal', choice.ordinal],
  ];
  if (choice.luid) entries.push(['luid', choice.luid]);
  if (choice.pci) entries.push(['pci', choice.pci]);
  return `{${entries.map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(', ')}}`;
}

const PROBE_TIMEOUT_MS = 15000;

/**
 * Lists the GPUs by running include/vk_gpus.py. The environment must not carry
 * this setting's own CUDA/HIP pins, which would hide the other GPUs.
 */
export function probeGpus(pythonPath: string, scriptPath: string, env: NodeJS.ProcessEnv): Promise<GpuInfo[]> {
  const probeEnv = { ...env };
  for (const key of GPU_ENV_KEYS) {
    if (process.env[key] === undefined) delete probeEnv[key];
    else probeEnv[key] = process.env[key];
  }
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonPath, ['-I', scriptPath], { env: probeEnv, cwd: path.dirname(scriptPath), windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`GPU probe timed out after ${PROBE_TIMEOUT_MS}ms`));
    }, PROBE_TIMEOUT_MS);
    proc.stdout.on('data', chunk => { stdout += chunk; });
    proc.stderr.on('data', chunk => { stderr += chunk; });
    proc.on('error', error => { clearTimeout(timer); reject(error); });
    proc.on('close', code => {
      clearTimeout(timer);
      if (stderr.trim()) logger.warn(`GPU probe: ${stderr.trim()}`);
      if (code !== 0) {
        reject(new Error(`GPU probe exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as GpuInfo[]);
      } catch (error) {
        reject(new Error(`GPU probe printed no GPU list: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}
