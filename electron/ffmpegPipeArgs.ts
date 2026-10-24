// electron/ffmpegPipeArgs.ts
import * as path from 'path';
import type { VideoMetadata } from './videoMetadataExtractor';
import type { OutputInfo } from './vspipeInfo';
import type { FFmpegConfig } from './ffmpegSettingsManager';
import { videoTimescaleFor, type AudioTrim } from './sourceTiming';

/**
 * The vspipe arguments for the main encode: the script's first output as
 * raw video in Matroska, which carries a timestamp for every frame. vspipe
 * accepts every format the app outputs, float RGB included.
 */
export function vspipeArgs(scriptPath: string): string[] {
  return ['-c', 'mkv', '--outputindex', '0', scriptPath, '-'];
}

export function isRgbFormat(pixelFormat: string | null | undefined): boolean {
  if (!pixelFormat) return false;
  return pixelFormat.includes('RGB') || pixelFormat.includes('GBR');
}

/** Containers whose video track takes its time base from -video_track_timescale. */
const MOV_FAMILY = new Set(['.mp4', '.mov', '.m4v']);

export interface PipeArgsInput {
  inputPath: string;
  outputPath: string;
  metadata: VideoMetadata;
  outputInfo: OutputInfo;
  ffmpegConfig: FFmpegConfig;
  /** How the source's audio and subtitles are cut to line up with the output video. */
  audioTrim: AudioTrim;
  benchmarkMode?: boolean;
}

/**
 * The input side shared by every run: the Matroska stream from vspipe, with
 * the BT.709 limited-range tags the template's YUV output is converted to
 * (vspipe writes no colour elements).
 */
function pipeInputArgs(outputInfo: OutputInfo): string[] {
  const args = ['-f', 'matroska'];
  if (!isRgbFormat(outputInfo.pixelFormat)) {
    args.push('-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709');
  }
  args.push('-i', 'pipe:0');
  return args;
}

/**
 * ffmpeg's arguments for a run: the encode, with the source's audio,
 * subtitles and metadata, and a 1 fps MJPEG preview on stdout. The video
 * keeps the timestamps vspipe wrote (passthrough), on a time base every one
 * of them lands on. Benchmark mode decodes the pipe into the null muxer.
 */
export function buildPipeFFmpegArgs(input: PipeArgsInput): string[] {
  const { inputPath, outputPath, metadata, outputInfo, ffmpegConfig, audioTrim } = input;
  const ffmpegArgs: string[] = ['-hide_banner', ...pipeInputArgs(outputInfo)];

  if (input.benchmarkMode) {
    ffmpegArgs.push('-f', 'null', '-');
    return ffmpegArgs;
  }

  if (audioTrim.start !== null) ffmpegArgs.push('-ss', audioTrim.start.toFixed(6));
  if (audioTrim.duration !== null) ffmpegArgs.push('-t', audioTrim.duration.toFixed(6));
  ffmpegArgs.push('-i', inputPath);

  // Main output: video from the pipe, audio and subtitles from the source
  ffmpegArgs.push('-map', '0:v:0');
  if (metadata.hasAudio) {
    ffmpegArgs.push('-map', '1:a?', '-c:a', 'copy');
  }
  if (metadata.hasSubtitles) {
    ffmpegArgs.push('-map', '1:s?', '-c:s', 'copy');
  }

  if (ffmpegConfig.videoArgs) {
    ffmpegArgs.push(...ffmpegConfig.videoArgs);
  }

  const timescale = videoTimescaleFor(outputInfo.fpsString, !!outputInfo.variableFrameRate);
  ffmpegArgs.push('-fps_mode:v:0', 'passthrough', '-enc_time_base:v:0', `1/${timescale}`);
  if (MOV_FAMILY.has(path.extname(outputPath).toLowerCase())) {
    ffmpegArgs.push('-video_track_timescale', `${timescale}`);
  }

  if (ffmpegConfig.preserveAspectRatio && metadata.dar) {
    ffmpegArgs.push('-aspect', metadata.dar);
  }
  if (ffmpegConfig.copyMetadata) {
    ffmpegArgs.push('-map_metadata', '1');
  }
  // MP4 and MOV get their index at the front, so playback can start before
  // the whole file is read, unless the encoding arguments set movflags themselves.
  const movflags = movflagsFor(outputPath, ffmpegConfig);
  if (movflags.length > 0) {
    ffmpegArgs.push('-movflags', movflags.join(','));
  }

  ffmpegArgs.push('-y', outputPath);

  // Preview output: JPEG frames to stdout
  ffmpegArgs.push('-map', '0:v:0');
  ffmpegArgs.push('-vf', 'fps=1,scale=-2:720'); // 1 fps preview, max height 720p
  ffmpegArgs.push('-f', 'image2pipe');
  ffmpegArgs.push('-c:v', 'mjpeg');
  ffmpegArgs.push('-pix_fmt', 'yuvj422p'); // YUV422 with full range
  ffmpegArgs.push('-q:v', '1'); // Quality 1 = highest quality (100%)
  ffmpegArgs.push('pipe:1');

  return ffmpegArgs;
}

/** The movflags for the main output. */
export function movflagsFor(outputPath: string, ffmpegConfig: Partial<FFmpegConfig>): string[] {
  const movflags = [...(ffmpegConfig.movflags ?? [])];
  if (MOV_FAMILY.has(path.extname(outputPath).toLowerCase()) && !ffmpegConfig.videoArgs?.includes('-movflags')
    && !movflags.includes('+faststart')) {
    movflags.push('+faststart');
  }
  return movflags;
}
