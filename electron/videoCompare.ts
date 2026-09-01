import * as fs from 'fs-extra';
import { spawn } from 'child_process';
import { resolveHostCommand } from './utils';

/**
 * Checks whether the video-compare executable can be launched. Windows uses
 * the app-managed binary while Linux resolves the optional host command using
 * PATH instead of treating its command name as a filesystem path.
 */
export function resolveVideoCompareCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  return platform === 'win32'
    ? (fs.existsSync(command) ? command : null)
    : resolveHostCommand(command);
}

export async function isVideoCompareAvailable(
  command: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  return resolveVideoCompareCommand(command, platform) !== null;
}

export function getVideoCompareUnavailableMessage(
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32'
    ? 'Video comparison tool not found. Please run setup again.'
    : 'Video comparison is optional on Linux. Install the video-compare command with your distribution package manager, then restart Vapourkit.';
}

/**
 * Starts video-compare detached and waits for process creation. Waiting for
 * the spawn event means a missing PATH command (ENOENT) is returned to the
 * renderer rather than incorrectly reporting a successful launch.
 *
 * Deliberately no windowsHide: it makes libuv pass STARTF_USESHOWWINDOW with
 * SW_HIDE in the STARTUPINFO, and Win32 has the first ShowWindow call of a
 * process take its show state from there instead of the requested one. SDL
 * still creates video-compare's window, but it never becomes visible, leaving
 * the process decoding into its frame buffer -- hundreds of MB, and no window
 * to close it from.
 */
export function launchVideoCompare(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
      });
    } catch (error) {
      reject(error);
      return;
    }

    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
