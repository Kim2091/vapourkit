import { describe, expect, it, vi } from 'vitest';

const execFile = vi.fn();
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execFile: (...args: unknown[]) => execFile(...args),
}));
vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), upscale: vi.fn() },
}));
vi.mock('./constants', () => ({ PATHS: {} }));
vi.mock('./utils', () => ({ setupVSEnvironment: () => ({}) }));
vi.mock('./ffmpegManager', () => ({ FFmpegManager: { getFFmpegPath: () => '/ffmpeg' } }));

import { probeVideo } from './videoUtils';

const FFMPEG_I = `Input #0, matroska,webm, from 'a.mkv':
  Duration: 00:01:02.50, start: 0.000000, bitrate: 1000 kb/s
  Stream #0:0: Video: h264 (High), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 23.98 fps, 23.98 tbr
  Stream #0:1(eng): Audio: aac, 48000 Hz, stereo
  Stream #0:2(eng): Subtitle: subrip
At least one output file must be specified
`;

describe('probing a source', () => {
  it('runs ffmpeg once and returns both the display and the stream view', async () => {
    execFile.mockReset();
    // ffmpeg -i with no output exits 1, which execFile reports as an error.
    execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(Object.assign(new Error('exit 1'), { code: 1, stdout: '', stderr: FFMPEG_I }), '', FFMPEG_I);
    });

    const probe = await probeVideo('a.mkv');

    expect(execFile).toHaveBeenCalledTimes(1);
    expect(probe.display).toMatchObject({ resolution: '1920x1080', fps: 23.98, codec: 'h264', container: 'matroska', duration: '00:01:02.50' });
    expect(probe.streams).toEqual({
      hasAudio: true, hasSubtitles: true, dar: '16:9', duration: 62.5, audioStreams: 1, subtitleStreams: 1,
    });
  });

  it('reports no stream view when ffmpeg could not start', async () => {
    execFile.mockReset();
    execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), '', '');
    });

    const probe = await probeVideo('a.mkv');

    expect(probe).toEqual({ display: {}, streams: null });
  });
});
