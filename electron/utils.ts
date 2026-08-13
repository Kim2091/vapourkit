// electron/utils.ts
import { spawn, spawnSync, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';
import { PATHS, IS_WINDOWS } from './constants';

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
    // Keep the executable and arguments separate. Using a shell here required
    // hand-quoting paths and allowed shell metacharacters in an argument to be
    // interpreted instead of passed to the child process.
    logger.debug(`Running command: ${JSON.stringify([command, ...args])}`);
    logger.debug(`Working directory: ${cwd || process.cwd()}`);
    
    const proc = spawn(command, args, {
      cwd: cwd || process.cwd(),
      shell: false,
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
    env['PATH'] = `${pythonDir}${path.delimiter}${env['PATH']}`;
    if (IS_WINDOWS) {
      // Embedded Python only — a venv must not have PYTHONHOME set
      env['PYTHONHOME'] = pythonDir;
    }
    env['PYTHONPATH'] = PATHS.SITE_PACKAGES;
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
 * GPU stats returned by pollGpuStats
 */
export interface GpuStats {
  gpuMemoryUsed: number;
  gpuMemoryTotal: number;
  gpuUtilization: number;
}

/**
 * Polls nvidia-smi for GPU memory and utilization stats.
 * Returns null if nvidia-smi is unavailable (non-NVIDIA systems).
 */
export async function pollGpuStats(): Promise<GpuStats | null> {
  try {
    const proc = spawn('nvidia-smi', [
      '--query-gpu=memory.used,memory.total,utilization.gpu',
      '--format=csv,noheader,nounits'
    ], {
      shell: false,
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
    // Try to run nvidia-smi to detect NVIDIA GPU
    const proc = spawn('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], {
      shell: false,
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

/** Checks whether an executable is available on the host PATH. */
export async function isCommandAvailable(command: string, probeArgs: string[] = ['--version']): Promise<boolean> {
  return new Promise(resolve => {
    const proc = spawn(command, probeArgs, {
      stdio: 'ignore',
      shell: false,
      windowsHide: true,
    });

    proc.once('error', () => resolve(false));
    proc.once('close', code => resolve(code === 0));
  });
}

/**
 * Resolves a command without executing it. GUI applications such as
 * video-compare do not necessarily implement a harmless `--version` probe.
 * Electron apps started from a desktop launcher also do not source a user's
 * shell profile. Linux discovery uses `whereis` so it follows the host's
 * standard binary paths and PATH without a distribution-specific directory list.
 */
export function resolveHostCommand(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const pathApi = platform === 'linux' ? path.posix : path;

  if (pathApi.isAbsolute(command)) {
    return isRunnableCommand(command, platform) ? command : null;
  }

  if (platform === 'linux') {
    const result = spawnSync('whereis', ['-b', command], {
      encoding: 'utf8',
      env: environment,
      windowsHide: true,
    });

    if (!result.error && result.status === 0) {
      const output = result.stdout.trim();
      const separator = output.indexOf(':');
      const candidates = separator === -1
        ? []
        : output.slice(separator + 1).trim().split(/\s+/).filter(Boolean);

      for (const candidate of candidates) {
        if (isRunnableCommand(candidate, platform)) {
          return candidate;
        }
      }
    }
  }

  // `whereis` is not installed on every minimal Linux image. The PATH
  // fallback is deliberately environment-driven; it does not reintroduce a
  // distro-specific directory list and preserves PATH order.
  const delimiter = platform === 'win32' ? ';' : ':';
  const searchPaths = (environment.PATH || '').split(delimiter).filter(Boolean);

  for (const directory of new Set(searchPaths)) {
    const candidate = pathApi.join(directory, command);
    if (isRunnableCommand(candidate, platform)) {
      return candidate;
    }
  }
  return null;
}

function isRunnableCommand(command: string, platform: NodeJS.Platform): boolean {
  try {
    if (!fs.statSync(command).isFile()) {
      return false;
    }
    if (platform === 'linux') {
      fs.accessSync(command, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

export interface PythonCommandCandidate {
  command: string;
  version: string | null;
}

export interface SupportedPythonResolution {
  command: string | null;
  version: string | null;
  candidates: PythonCommandCandidate[];
}

const PYTHON_VERSION_PROBE = 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")';

/** Returns the host interpreter's major/minor Python version, if runnable. */
export async function getPythonVersion(command: string): Promise<string | null> {
  return new Promise(resolve => {
    let output = '';
    const proc = spawn(command, ['-c', PYTHON_VERSION_PROBE], {
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false,
      windowsHide: true,
    });

    proc.stdout?.on('data', chunk => {
      output += chunk.toString();
    });

    proc.once('error', () => resolve(null));
    proc.once('close', code => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      resolve(output.trim().split(/\r?\n/).pop() || null);
    });
  });
}

/** True when `version` is within Vapourkit's supported Python ABI range. */
export function isSupportedPythonVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) {
    return false;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major === 3 && minor >= 12 && minor <= 14;
}

/** Finds a supported host Python executable using the host environment. */
export async function resolveSupportedPythonCommand(
  candidates: string[] = ['python3', 'python'],
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<SupportedPythonResolution> {
  const checked = new Set<string>();
  const detected: PythonCommandCandidate[] = [];

  for (const candidate of candidates) {
    const command = resolveHostCommand(candidate, environment, platform);
    if (!command || checked.has(command)) {
      continue;
    }
    checked.add(command);

    const version = await getPythonVersion(command);
    detected.push({ command, version });
    if (version && isSupportedPythonVersion(version)) {
      return { command, version, candidates: detected };
    }
  }

  return { command: null, version: null, candidates: detected };
}

/** True when `command` runs a supported Python version. */
export async function isSupportedPython(command: string): Promise<boolean> {
  const version = await getPythonVersion(command);
  return version !== null && isSupportedPythonVersion(version);
}
