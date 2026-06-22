// electron/utils.ts
import { spawn } from 'child_process';
import * as path from 'path';
import * as si from 'systeminformation';
import { logger } from './logger';
import { PATHS } from './constants';

export interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Extracts error message from unknown error type
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return String(error);
}

/**
 * Fixes ASAR unpacked paths for native modules
 */
export function fixAsarPath(filePath: string): string {
  if (filePath && filePath.includes('app.asar') && !filePath.includes('app.asar.unpacked')) {
    return filePath.replace('app.asar', 'app.asar.unpacked');
  }
  return filePath;
}

/**
 * Returns the app base path with ASAR unpacking applied.
 * Use this whenever you need to access bundled files from include/.
 */
export function getBundledBasePath(): string {
  const { app } = require('electron');
  return fixAsarPath(app.getAppPath());
}

/**
 * Shared utility to run a command with stdout/stderr capture
 */
export async function runCommand(
  command: string,
  args: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Quote command if it contains spaces (Windows compatibility)
    const quotedCommand = command.includes(' ') ? `"${command}"` : command;
    
    // Quote args that contain spaces (Windows compatibility)
    const quotedArgs = args.map(arg => arg.includes(' ') ? `"${arg}"` : arg);
    
    logger.debug(`Running command: ${quotedCommand} ${quotedArgs.join(' ')}`);
    logger.debug(`Working directory: ${cwd || process.cwd()}`);
    
    const proc = spawn(quotedCommand, quotedArgs, {
      cwd: cwd || process.cwd(),
      shell: true,
      env: env || process.env
    });

    let stdout = '';
    let stderr = '';

    if (proc.stdout) {
      proc.stdout.on('data', (data) => {
        const output = data.toString();
        stdout += output;
        logger.debug(`[stdout] ${output.trim()}`);
      });
    }

    if (proc.stderr) {
      proc.stderr.on('data', (data) => {
        const output = data.toString();
        stderr += output;
        logger.debug(`[stderr] ${output.trim()}`);
      });
    }

    proc.on('close', (code) => {
      if (code === 0) {
        logger.debug(`Command completed successfully with code ${code}`);
        resolve();
      } else {
        const errorMsg = `Command failed with code ${code}: ${stderr || stdout}`;
        logger.error(errorMsg);
        reject(new Error(errorMsg));
      }
    });

    proc.on('error', (error) => {
      logger.error('Command execution error:', error);
      reject(error);
    });
  });
}

/**
 * Setup VapourSynth environment variables
 */
export function setupVSEnvironment(pythonPath?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  
  // Setup Python environment if path provided
  if (pythonPath) {
    const pythonDir = path.dirname(pythonPath);
    env['PATH'] = `${pythonDir};${env['PATH']}`;
    env['PYTHONHOME'] = pythonDir;
    env['PYTHONPATH'] = path.join(pythonDir, 'Lib', 'site-packages');
  }
  
  // Setup VapourSynth plugin paths
  env['VS_PLUGINS_PATH'] = PATHS.PLUGINS;
  env['VAPOURSYNTH_PLUGINS_PATH'] = PATHS.PLUGINS;
  
  return env;
}


/**
 * Wrapper for operations that need logging separators
 */
export async function withLogSeparator<T>(
  operation: () => Promise<T>,
  startMessage?: string
): Promise<T> {
  logger.separator();
  if (startMessage) {
    logger.info(startMessage);
  }
  try {
    const result = await operation();
    logger.separator();
    return result;
  } catch (error) {
    logger.separator();
    throw error;
  }
}

/**
 * A detected GPU device from WMI enumeration
 */
export interface GpuDevice {
  index: number;
  name: string;
  adapterRAM: number; // MB, 0 if unknown
  vendor: 'nvidia' | 'amd' | 'intel' | 'other';
}

/**
 * Enumerates available GPUs via systeminformation.
 * The controller array order matches DXGI adapter indices.
 * Results are cached after the first successful call.
 */
let gpuCache: GpuDevice[] | null = null;

export async function enumerateGpus(): Promise<GpuDevice[]> {
  if (gpuCache) return gpuCache;

  try {
    const graphics = await si.graphics();
    const devices: GpuDevice[] = [];

    graphics.controllers.forEach((controller, index) => {
      const name = controller.model || controller.name || 'Unknown GPU';

      // Filter out software renderers and basic display adapters
      const lower = name.toLowerCase();
      if (lower.includes('microsoft') || lower.includes('basic')) return;

      const lowerVendor = (controller.vendor || '').toLowerCase();
      let vendor: GpuDevice['vendor'] = 'other';
      if (lowerVendor.includes('nvidia') || lower.includes('nvidia')) vendor = 'nvidia';
      else if (lowerVendor.includes('amd') || lower.includes('radeon')) vendor = 'amd';
      else if (lowerVendor.includes('intel') || lower.includes('intel')) vendor = 'intel';

      devices.push({
        index,
        name,
        adapterRAM: controller.vram || 0, // MB, from systeminformation
        vendor
      });
    });

    logger.info(`Enumerated ${devices.length} GPU(s): ${devices.map(g => g.name).join(', ')}`);
    gpuCache = devices;
    return devices;
  } catch (error) {
    logger.error(`GPU enumeration failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/**
 * Clears the cached GPU list. Useful for testing or manual refresh.
 */
export function clearGpuCache(): void {
  gpuCache = null;
}

/**
 * GPU stats returned by pollGpuStats
 */
export interface GpuStats {
  gpuMemoryUsed: number;
  gpuMemoryTotal: number;
  gpuUtilization: number;
}

/**
 * Resolves the path to nvidia-smi.exe by checking PATH first,
 * then falling back to the standard system location.
 * Returns the command string (may be just 'nvidia-smi' if found on PATH)
 * or null if not found anywhere.
 */
const NVIDIA_SMI_PATH = 'C:\\Windows\\System32\\nvidia-smi.exe';

async function resolveNvidiaSmiPath(): Promise<string | null> {
  // Try PATH first (fast path)
  try {
    const pathCheck = await new Promise<boolean>((resolve) => {
      const proc = spawn('nvidia-smi', ['--version'], {
        shell: true,
        windowsHide: true,
        stdio: 'ignore'
      });
      proc.on('close', (code) => resolve(code === 0));
      proc.on('error', () => resolve(false));
      setTimeout(() => { proc.kill(); resolve(false); }, 2000);
    });
    if (pathCheck) return 'nvidia-smi';
  } catch {
    // fall through
  }

  // Fallback: standard system location
  try {
    const exists = require('fs').existsSync(NVIDIA_SMI_PATH);
    if (exists) return NVIDIA_SMI_PATH;
  } catch {
    // fall through
  }

  return null;
}

/**
 * Polls nvidia-smi for GPU memory and utilization stats.
 * Returns null if nvidia-smi is unavailable (non-NVIDIA systems).
 */
export async function pollGpuStats(): Promise<GpuStats | null> {
  try {
    const nvidiaSmi = await resolveNvidiaSmiPath();
    if (!nvidiaSmi) return null;

    const proc = spawn(nvidiaSmi, [
      '--query-gpu=memory.used,memory.total,utilization.gpu',
      '--format=csv,noheader,nounits'
    ], {
      shell: true,
      windowsHide: true
    });

    return new Promise((resolve) => {
      let output = '';

      if (proc.stdout) {
        proc.stdout.on('data', (data) => {
          output += data.toString();
        });
      }

      proc.on('close', (code) => {
        if (code === 0 && output.trim()) {
          const parts = output.trim().split(',').map(s => s.trim());
          if (parts.length >= 3) {
            resolve({
              gpuMemoryUsed: parseInt(parts[0], 10),
              gpuMemoryTotal: parseInt(parts[1], 10),
              gpuUtilization: parseInt(parts[2], 10)
            });
            return;
          }
        }
        resolve(null);
      });

      proc.on('error', () => resolve(null));

      setTimeout(() => {
        proc.kill();
        resolve(null);
      }, 3000);
    });
  } catch {
    return null;
  }
}

/**
 * Detects if CUDA-capable NVIDIA GPU is available
 */
export async function detectCudaSupport(): Promise<boolean> {
  try {
    const nvidiaSmi = await resolveNvidiaSmiPath();
    if (!nvidiaSmi) {
      logger.info('nvidia-smi not found - no CUDA support');
      return false;
    }

    // Try to run nvidia-smi to detect NVIDIA GPU
    const proc = spawn(nvidiaSmi, ['--query-gpu=name', '--format=csv,noheader'], {
      shell: true,
      windowsHide: true
    });

    return new Promise((resolve) => {
      let hasOutput = false;

      if (proc.stdout) {
        proc.stdout.on('data', (data) => {
          const output = data.toString().trim();
          if (output.length > 0) {
            hasOutput = true;
            logger.info(`CUDA GPU detected: ${output}`);
          }
        });
      }

      proc.on('close', (code) => {
        if (code === 0 && hasOutput) {
          logger.info('CUDA support detected');
          resolve(true);
        } else {
          logger.info('No CUDA support detected');
          resolve(false);
        }
      });

      proc.on('error', () => {
        logger.info('nvidia-smi not found - no CUDA support');
        resolve(false);
      });

      // Timeout after 3 seconds
      setTimeout(() => {
        proc.kill();
        resolve(false);
      }, 3000);
    });
  } catch (error) {
    logger.info('Error detecting CUDA support:', error);
    return false;
  }
}