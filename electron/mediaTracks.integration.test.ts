import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildPipeFFmpegArgs } from './ffmpegPipeArgs';
import { DEFAULT_ENCODING, simpleArgsOf, splitArgs, type SimpleEncoding } from './encodingSettings';

describe.skipIf(process.env.VK_MEDIA_TESTS !== '1')('real FFmpeg/VapourSynth track selection', () => {
  let dir: string; let source: string; let script: string;
  const children: ChildProcess[] = [];
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vk-track-tests-')); source = join(dir, 'source ü.mkv'); script = join(dir, 'source.vpy');
    const subtitles = join(dir, 'subtitles.srt');
    writeFileSync(subtitles, '1\n00:00:00,000 --> 00:00:00,900\nSubtitle fixture\n');
    writeFileSync(script, 'import vapoursynth as vs\nvs.core.std.BlankClip(width=160,height=120,length=24,fpsnum=24,format=vs.YUV420P8).set_output()\n');
    const built = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440', '-f', 'lavfi', '-i', 'sine=frequency=880', '-i', subtitles,
      '-t', '1', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-c:s', 'srt', '-metadata', 'title=Track fixture', '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=fra', '-y', source], { encoding: 'utf8', timeout: 20000 });
    expect(built.status, built.stderr).toBe(0);
  }, 25000);
  afterAll(() => { for (const child of children) if (child.exitCode === null) child.kill(); if (dir) rmSync(dir, { recursive: true, force: true }); });
  async function encode(name: string, audioTracks?: number[], subtitleTracks?: number[], simple: SimpleEncoding = DEFAULT_ENCODING.simple) {
    const output = join(dir, name + '.mkv');
    const args = buildPipeFFmpegArgs({ inputPath: source, outputPath: output,
      metadata: { hasAudio: true, hasSubtitles: true, dar: null, duration: 1, startTime: 0, audioStreams: 2, subtitleStreams: 1 },
      outputInfo: { frames: 24, resolution: '160x120', fps: 24, fpsString: '24/1', pixelFormat: 'YUV420P8' },
      ffmpegConfig: { videoArgs: splitArgs(simpleArgsOf(simple)), audioTracks, subtitleTracks },
      audioTrim: { start: null, duration: null, exact: true }, previewEnabled: false });
    const producer = spawn('vspipe', ['-c', 'mkv', '--outputindex', '0', script, '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const consumer = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] }); children.push(producer, consumer);
    let error = ''; for (const child of [producer, consumer]) child.stderr!.on('data', data => { error = (error + data.toString()).slice(-10000); });
    consumer.stdout!.resume(); consumer.stdin!.on('error', () => {}); producer.stdout!.pipe(consumer.stdin!);
    const statuses = await Promise.all([producer, consumer].map(child => new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); })));
    expect(statuses, error).toEqual([0, 0]);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], { encoding: 'utf8', timeout: 10000 });
    expect(probe.status, probe.stderr).toBe(0);
    return JSON.parse(probe.stdout) as { streams: { codec_type: string; codec_name: string; channels?: number; tags?: Record<string, string> }[]; format: { tags?: Record<string, string> } };
  }
  it('keeps the requested audio language, converts it to AAC/stereo and removes subtitles', async () => {
    const result = await encode('selected', [1], [], { ...DEFAULT_ENCODING.simple, rateControl: 'bitrate', bitrateMbps: 1, keyframeInterval: 12, audioCodec: 'aac', audioBitrateKbps: 128, audioChannels: 2 });
    expect(result.streams.map(s => s.codec_type)).toEqual(['video', 'audio']);
    expect(result.streams[1]).toMatchObject({ codec_name: 'aac', channels: 2, tags: { language: 'fra' } });
  }, 30000);
  it('keeps all audio and subtitles when no selection was made', async () => {
    const result = await encode('all');
    expect(result.streams.map(s => s.codec_type)).toEqual(['video', 'audio', 'audio', 'subtitle']);
  }, 30000);
  it('removes all audio/subtitles and honors the metadata switch', async () => {
    const result = await encode('none', [], [], { ...DEFAULT_ENCODING.simple, copyMetadata: false });
    expect(result.streams.map(s => s.codec_type)).toEqual(['video']); expect(result.format.tags?.title).toBeUndefined();
  }, 30000);
  it('handles a batch source without the requested track ordinal without re-enabling all audio', async () => {
    const result = await encode('missing-track', [9], []);
    expect(result.streams.map(s => s.codec_type)).toEqual(['video']);
  }, 30000);
});
