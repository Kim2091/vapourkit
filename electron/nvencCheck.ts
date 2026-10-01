// electron/nvencCheck.ts
//
// Whether the NVIDIA driver can run the bundled FFmpeg's NVENC encoders.
//
// FFmpeg is built against one NVENC SDK and refuses a driver that predates it:
//   [h264_nvenc] Driver does not support the required nvenc API version. Required: 13.1 Found: 13.0
//   [h264_nvenc] The minimum required Nvidia driver for nvenc is 610.00 or newer
// The encode then dies before its first frame, and what reaches the user is
// "Output file is empty", or a broken pipe on the VapourSynth side. gyan.dev
// builds every FFmpeg - releases and git snapshots alike - with the newest SDK,
// so pinning an older FFmpeg does not help; the driver is what has to move.
//
// So launch asks ffmpeg directly, with a one-frame test encode, instead of
// comparing driver numbers against a table that would drift with each FFmpeg
// update. The error text is the same one a failed encode produces, so both
// paths share parseNvencDriverError.

import { spawn } from 'child_process';
import { logger } from './logger';

export interface NvencDriverError {
  /** NVENC API version this FFmpeg needs, e.g. "13.1" */
  required: string;
  /** NVENC API version the installed driver offers, e.g. "13.0" */
  found: string;
  /** Minimum NVIDIA driver FFmpeg names, e.g. "610.00", when it says */
  minDriver: string | null;
}

export function parseNvencDriverError(output: string): NvencDriverError | null {
  const versions = /Driver does not support the required nvenc API version\. Required: ([\d.]+) Found: ([\d.]+)/i.exec(output);
  if (!versions) return null;
  const driver = /minimum required Nvidia driver for nvenc is ([\d.]+)/i.exec(output);
  return { required: versions[1], found: versions[2], minDriver: driver ? driver[1] : null };
}

/** The user-facing explanation, for the launch notice and for failed encodes. */
export function describeNvencDriverError(error: NvencDriverError): string {
  const driver = error.minDriver ? `${error.minDriver.replace(/\.0+$/, '')} or newer` : 'a newer version';
  return `Your NVIDIA driver is too old for NVENC hardware encoding: Vapourkit's FFmpeg needs NVENC ` +
    `${error.required}, and the driver offers ${error.found}. Update the NVIDIA driver to ${driver}, ` +
    'or choose a CPU encoder (x264, x265 or SVT-AV1) in the encoding settings.';
}

/**
 * A one-frame NVENC test encode. Null when NVENC works or failed for any
 * other reason (no NVENC on this GPU, ffmpeg missing): only the driver case
 * has a clear fix to tell the user about.
 */
export function probeNvencDriver(ffmpegPath: string, timeoutMs = 20000): Promise<NvencDriverError | null> {
  return new Promise(resolve => {
    let output = '';
    let settled = false;
    const finish = (result: NvencDriverError | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const child = spawn(ffmpegPath, [
      '-hide_banner', '-nostdin',
      '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.1',
      '-frames:v', '1', '-c:v', 'h264_nvenc', '-f', 'null', '-',
    ], { windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      logger.warn('NVENC driver check timed out');
      finish(null);
    }, timeoutMs);

    child.stderr?.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('error', () => finish(null));
    child.on('close', () => {
      const result = parseNvencDriverError(output);
      if (result) {
        logger.warn(`NVENC unavailable: driver offers NVENC ${result.found}, FFmpeg needs ${result.required}` +
          (result.minDriver ? ` (driver ${result.minDriver}+)` : ''));
      }
      finish(result);
    });
  });
}
