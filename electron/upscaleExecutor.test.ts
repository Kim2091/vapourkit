import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.fn();
vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => spawn(...args) }));
vi.mock('fs-extra', () => ({ pathExists: async () => true, readFile: async () => 'script' }));
vi.mock('./logger', () => ({
  logger: {
    upscale: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(),
    errorWithDialog: vi.fn(), separator: vi.fn(), getLogPath: () => '/log',
  },
}));
vi.mock('./constants', () => ({ PATHS: { PLUGINS: '/plugins' } }));
vi.mock('./utils', () => ({ setupVSEnvironment: () => ({}), pollGpuStats: async () => null }));
vi.mock('./ffmpegManager', () => ({
  FFmpegManager: { getFFmpegPath: () => '/ffmpeg', isInstalled: async () => true },
}));
vi.mock('./configManager', () => ({ configManager: {} }));
vi.mock('./ffmpegSettingsManager', () => ({
  FFmpegSettingsManager: { loadFFmpegConfig: async () => ({ videoArgs: [] }) },
}));
vi.mock('./processLifecycle', () => ({
  createWorkloadSpawnOptions: (o: unknown) => o,
  terminateProcessTree: vi.fn(),
}));

let releaseProbe: (info: object) => void = () => {};
vi.mock('./videoMetadataExtractor', () => ({
  VideoMetadataExtractor: {
    validateVideoForUpscaling: async () => ({ valid: true }),
    getVideoMetadata: async () => ({ hasAudio: false, hasSubtitles: false, dar: null, duration: null, audioStreams: 0, subtitleStreams: 0 }),
  },
}));
vi.mock('./vapourSynthInfoExtractor', () => ({
  VapourSynthInfoExtractor: class {
    onBuildStatus?: unknown;
    cancelAll() {
      releaseProbe({ resolution: null, fps: null, fpsString: null, error: 'killed' });
    }
    getOutputInfo() {
      return new Promise(resolve => { releaseProbe = resolve; });
    }
    getFrameCount() {
      return Promise.resolve(10);
    }
  },
}));

import { UpscaleExecutor } from './upscaleExecutor';

const okInfo = { resolution: '64x64', fps: 24, fpsString: '24/1', pixelFormat: 'YUV420P8', error: null };

describe('stopping an upscale before it spawns', () => {
  beforeEach(() => spawn.mockReset());

  it.each(['cancel', 'kill'] as const)('%s during the graph probe starts nothing', async (stop) => {
    const executor = new UpscaleExecutor('/vs/vspipe', '/py');
    const run = executor.execute('/s.vpy', '/out.mkv', '/in.mkv', 10);
    // Let execute() reach the probe.
    await new Promise(resolve => setTimeout(resolve, 0));
    executor[stop]();

    await expect(run).rejects.toThrow('Canceled');
    expect(spawn).not.toHaveBeenCalled();
    expect(executor.isStopped).toBe(true);
  });

  it('a stop that lands after the probe still starts nothing', async () => {
    const executor = new UpscaleExecutor('/vs/vspipe', '/py');
    const run = executor.execute('/s.vpy', '/out.mkv', '/in.mkv', 10);
    await new Promise(resolve => setTimeout(resolve, 0));
    releaseProbe(okInfo);
    executor.kill();

    await expect(run).rejects.toThrow('Canceled');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('a stopped executor refuses a new run', async () => {
    const executor = new UpscaleExecutor('/vs/vspipe', '/py');
    executor.cancel();
    await expect(executor.execute('/s.vpy', '/out.mkv', '/in.mkv', 10)).rejects.toThrow('Canceled');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('reports a failed graph probe instead of starting the run', async () => {
    const executor = new UpscaleExecutor('/vs/vspipe', '/py');
    const run = executor.execute('/s.vpy', '/out.mkv', '/in.mkv', 10);
    await new Promise(resolve => setTimeout(resolve, 0));
    releaseProbe({ ...okInfo, resolution: null, error: 'Python exception: no module' });

    await expect(run).rejects.toThrow('Python exception: no module');
    expect(spawn).not.toHaveBeenCalled();
  });
});
