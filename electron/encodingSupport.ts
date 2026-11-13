import { spawn } from 'child_process';
import { parseNvencDriverError, describeNvencDriverError } from './nvencCheck';
import { splitArgs } from './encodingSettings';
import { terminateProcessTree, createWorkloadSpawnOptions } from './processLifecycle';

import { NVENC_FORMATS, type NvencEncoder, type EncodingSupport } from './encodingSupportTypes';
export { NVENC_FORMATS };
export type { NvencEncoder, EncodingSupport };

export function nvencEncoderOf(args: string): NvencEncoder | null {
  const parts = splitArgs(args);
  let encoder: string | undefined;
  parts.forEach((part, i) => { if (['-c:v', '-codec:v', '-vcodec', '-c:v:0'].includes(part)) encoder = parts[i + 1]; });
  return ['h264_nvenc', 'hevc_nvenc', 'av1_nvenc'].includes(encoder ?? '') ? encoder as NvencEncoder : null;
}

/** Keep the cause ahead of generic "broken pipe" / "output file is empty" messages. */
export function explainNvencFailure(output: string, assumeNvenc = false): EncodingSupport | null {
  const clean = output.replace(/\0/g, '');
  const driver = parseNvencDriverError(clean);
  if (driver) return { available: false, category: 'driver', message: describeNvencDriverError(driver) };
  if (!assumeNvenc && !/nvenc|nvEncodeAPI|libnvidia-encode/i.test(clean)) return null;
  if (/too many.*sessions|no free.*sessions|OpenEncodeSessionEx failed.*(?:memory|resource)|encoder.*busy/i.test(clean)) {
    return { available: false, category: 'sessions', message: 'NVENC could not open another encoding session. Close other video encoders, recording or streaming apps and retry. You can use CPU encoding while those apps are running.' };
  }
  if (/10.?bit.*not support|unsupported.*(?:bit depth|pixel format)|(?:pixel format|4:2:2|4:4:4|yuv422|yuv444).*not support/i.test(clean)) {
    return { available: false, category: 'format', message: 'This NVENC encoder cannot encode the chosen pixel format on this GPU. Choose YUV 4:2:0 8-Bit, or use a CPU encoder to keep the selected format. HEVC 10-bit requires a compatible NVIDIA GPU.' };
  }
  if (/cannot load.*(?:cuda|nvenc|nvEncode|nvidia)|failed to (?:load|initiali[sz]e).*driver|CUDA_ERROR_NO_DEVICE/i.test(clean)) {
    return { available: false, category: 'libraries', message: 'NVENC could not load the NVIDIA encoding driver. Install or repair the NVIDIA graphics driver and restart Vapourkit. On Linux, ensure the NVIDIA video-encode libraries are installed and exposed to containers. CPU encoding works without NVENC.' };
  }
  if (/unknown encoder|encoder.*not found/i.test(clean)) {
    return { available: false, category: 'ffmpeg', message: 'This FFmpeg build does not include the selected NVENC encoder. Repair FFmpeg using Start Setup in Settings, or select CPU encoding.' };
  }
  if (/no (?:nvenc )?capable devices|unsupported device|does not support.*(?:codec|encod)|unsupported.*(?:codec|feature)|provided device.*not support/i.test(clean)) {
    return { available: false, category: 'unsupported', message: 'This NVIDIA GPU does not support the selected NVENC codec or features. Try H.264 with YUV 4:2:0 8-Bit; AV1 encoding needs a newer GPU. Use CPU encoding if hardware encoding is unavailable.' };
  }
  return assumeNvenc || /nvenc.*(?:error|failed)|(?:error|failed).*nvenc/i.test(clean)
    ? { available: false, category: 'unknown', message: 'NVENC failed to initialize. Retry with H.264, YUV 4:2:0 8-Bit and a default preset, update the NVIDIA driver, or use CPU encoding. The encoder test below includes the original error.' }
    : null;
}

export function probeNvencEncoder(ffmpegPath: string, encoder: NvencEncoder, pixelFormat: string,
  timeoutMs = 15000, isCancelled: () => boolean = () => false): Promise<EncodingSupport> {
  if (!['h264_nvenc', 'hevc_nvenc', 'av1_nvenc'].includes(encoder)) return Promise.reject(new Error('Unsupported encoder'));
  // Only known processing formats become arguments, never renderer-supplied filters or commands.
  const format = NVENC_FORMATS[pixelFormat] ?? 'yuv420p';
  return new Promise(resolve => {
    let stderr = ''; let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancellation: ReturnType<typeof setInterval> | undefined;
    const finish = (result: EncodingSupport) => {
      if (settled) return; settled = true;
      if (timer) clearTimeout(timer); if (cancellation) clearInterval(cancellation);
      resolve(result);
    };
    const child = spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=24',
      '-vf', `format=${format}`, '-frames:v', '1', '-c:v', encoder, '-preset', 'p4', '-rc', 'vbr', '-cq', '20', '-b:v', '0', '-f', 'null', '-'], createWorkloadSpawnOptions({ windowsHide: true }));
    child.stdout?.resume();
    child.stderr?.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-16384); });
    child.on('error', error => finish({ available: false, category: 'ffmpeg', message: 'FFmpeg could not start. Repair FFmpeg using Start Setup in Settings, then retry the encoder test.', details: error.message }));
    child.on('close', code => finish(code === 0
      ? { available: true, category: 'ready', message: 'The selected NVENC encoder successfully encoded a test frame.' }
      : { ...explainNvencFailure(stderr, true)!, details: stderr.trim().slice(-4000) }));
    timer = setTimeout(() => {
      terminateProcessTree(child);
      finish({ available: false, category: 'timeout', message: 'The NVENC test timed out. Close other GPU applications, update or repair the NVIDIA driver and retry, or use CPU encoding.' });
    }, timeoutMs);
    cancellation = setInterval(() => { if (isCancelled()) { terminateProcessTree(child); finish({ available: false, category: 'cancelled', message: 'Cancelled' }); } }, 50);
  });
}

// The UI's advisory test and a render preflight may arrive together. Sharing
// that probe avoids consuming two hardware sessions just to test one encoder.
const inFlight = new Map<string, Promise<EncodingSupport>>();
export function checkNvencEncoder(ffmpegPath: string, encoder: NvencEncoder, pixelFormat: string,
  isCancelled: () => boolean = () => false): Promise<EncodingSupport> {
  const key = JSON.stringify([ffmpegPath, encoder, pixelFormat]);
  let pending = inFlight.get(key);
  if (!pending) {
    pending = probeNvencEncoder(ffmpegPath, encoder, pixelFormat, 15000, isCancelled)
      .finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending.then(result => isCancelled() ? { available: false, category: 'cancelled', message: 'Cancelled' } : result);
}
