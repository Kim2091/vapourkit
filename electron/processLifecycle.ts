import { exec, type ChildProcess, type SpawnOptions } from 'child_process';
import { logger } from './logger';

/**
 * Linux workloads run in their own process group so cancellation reaches
 * descendants such as vspipe-launched engine builders as well as the parent.
 */
export function createWorkloadSpawnOptions<T extends SpawnOptions>(
  options: T,
  platform: NodeJS.Platform = process.platform,
): T {
  return (platform === 'win32' ? options : { ...options, detached: true }) as T;
}

/** Terminates a process tree, including the POSIX process group when present. */
export function terminateProcessTree(
  proc: ChildProcess,
  signal: NodeJS.Signals = 'SIGKILL',
): void {
  if (!proc.pid) return;

  if (process.platform === 'win32') {
    exec(`taskkill /F /T /PID ${proc.pid}`, error => {
      if (error && !error.message.includes('not found')) {
        logger.debug(`taskkill error (may already be dead): ${error.message}`);
      }
    });
    return;
  }

  try {
    // A negative PID addresses the complete POSIX process group. Workloads
    // spawned via createWorkloadSpawnOptions own such a group on Unix.
    process.kill(-proc.pid, signal);
  } catch {
    // Retain a safe fallback for a process created before process-group support
    // or for a process that has already exited.
    try {
      proc.kill(signal);
    } catch {
      // Process may already be gone.
    }
  }
}
