// electron/utils.ts
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
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

// electron/utils.ts - Add after line 124

/**
 * Detects if CUDA-capable NVIDIA GPU is available
 */
export async function detectCudaSupport(): Promise<boolean> {
  try {
    // Try to run nvidia-smi to detect NVIDIA GPU
    const proc = spawn('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], {
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