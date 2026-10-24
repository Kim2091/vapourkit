import { describe, expect, it } from 'vitest';
import { buildPipeFFmpegArgs, vspipeArgs, type PipeArgsInput } from './ffmpegPipeArgs';

const metadata = { hasAudio: true, hasSubtitles: true, dar: '16:9', duration: 4, startTime: 0, audioStreams: 1, subtitleStreams: 1 };
const cfr = { frames: 96, resolution: '1920x1080', fps: 23.976, fpsString: '24000/1001', pixelFormat: 'YUV420P10', variableFrameRate: false };
const vfr = { ...cfr, frames: 108, fps: 26.975, fpsString: '107000000/3966667', variableFrameRate: true };
const noTrim = { start: null, duration: null, exact: true };

const build = (over: Partial<PipeArgsInput> = {}) => buildPipeFFmpegArgs({
  inputPath: 'C:/in.mp4', outputPath: 'C:/out.mp4', metadata, outputInfo: cfr,
  ffmpegConfig: { videoArgs: ['-c:v', 'libx265'], copyMetadata: true, preserveAspectRatio: true, movflags: ['+faststart'] },
  audioTrim: noTrim, ...over,
});

/** The value after `flag`, or undefined. */
const valueOf = (args: string[], flag: string) => {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
};

describe('the vspipe side', () => {
  it('writes the first output as Matroska, which carries per-frame timestamps', () => {
    expect(vspipeArgs('C:/s.vpy')).toEqual(['-c', 'mkv', '--outputindex', '0', 'C:/s.vpy', '-']);
  });
});

describe('the ffmpeg encode', () => {
  it('reads the pipe as Matroska with the BT.709 tags of the YUV output', () => {
    const args = build();
    const pipe = args.indexOf('pipe:0');
    expect(args.slice(0, pipe + 1)).toEqual([
      '-hide_banner', '-f', 'matroska',
      '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-i', 'pipe:0',
    ]);
    expect(args).not.toContain('yuv4mpegpipe');
    expect(args).not.toContain('-r');
  });

  it('tags no YUV colour on an RGB output, float RGB included', () => {
    for (const pixelFormat of ['RGB24', 'RGBS', 'RGBH']) {
      const args = build({ outputInfo: { ...cfr, pixelFormat } });
      expect(args.slice(0, args.indexOf('pipe:0') + 1)).toEqual(['-hide_banner', '-f', 'matroska', '-i', 'pipe:0']);
    }
  });

  it('keeps every frame\'s timestamp on the main output, on a time base each lands on', () => {
    const args = build();
    expect(valueOf(args, '-fps_mode:v:0')).toBe('passthrough');
    expect(valueOf(args, '-enc_time_base:v:0')).toBe('1/24000');
    expect(valueOf(args, '-video_track_timescale')).toBe('24000');
    // Before the main output's file name, so they apply to it and not the preview.
    expect(args.indexOf('-fps_mode:v:0')).toBeLessThan(args.indexOf('C:/out.mp4'));
  });

  it('uses microseconds for a variable rate output', () => {
    const args = build({ outputInfo: vfr });
    expect(valueOf(args, '-enc_time_base:v:0')).toBe('1/1000000');
    expect(valueOf(args, '-video_track_timescale')).toBe('1000000');
  });

  it('sets no MP4 track timescale on a Matroska output', () => {
    const args = build({ outputPath: 'C:/out.mkv', outputInfo: vfr });
    expect(args).not.toContain('-video_track_timescale');
    expect(valueOf(args, '-fps_mode:v:0')).toBe('passthrough');
  });

  it('trims the source input, and only it, by the given times', () => {
    const args = build({ audioTrim: { start: 1.25, duration: 1.81667, exact: true } });
    const source = args.indexOf('C:/in.mp4');
    expect(args.slice(source - 5, source + 1)).toEqual(['-ss', '1.250000', '-t', '1.816670', '-i', 'C:/in.mp4']);
    expect(args.indexOf('-ss')).toBeGreaterThan(args.indexOf('pipe:0'));
  });

  it('leaves the source untrimmed when there is nothing to cut', () => {
    const args = build();
    expect(args).not.toContain('-ss');
    expect(args).not.toContain('-t');
  });

  it('maps audio, subtitles and metadata from the source and keeps the preview output', () => {
    const args = build();
    expect(args.join(' ')).toContain('-map 0:v:0 -map 1:a? -c:a copy -map 1:s? -c:s copy -c:v libx265');
    expect(valueOf(args, '-aspect')).toBe('16:9');
    expect(valueOf(args, '-map_metadata')).toBe('1');
    expect(valueOf(args, '-movflags')).toBe('+faststart');
    expect(args.slice(args.indexOf('C:/out.mp4') - 1)).toEqual([
      '-y', 'C:/out.mp4',
      '-map', '0:v:0', '-vf', 'fps=1,scale=-2:720', '-f', 'image2pipe', '-c:v', 'mjpeg', '-pix_fmt', 'yuvj422p', '-q:v', '1', 'pipe:1',
    ]);
  });

  it('decodes the pipe into the null muxer in benchmark mode', () => {
    expect(build({ benchmarkMode: true, outputInfo: { ...cfr, pixelFormat: 'RGBS' } })).toEqual([
      '-hide_banner', '-f', 'matroska', '-i', 'pipe:0', '-f', 'null', '-',
    ]);
  });
});
