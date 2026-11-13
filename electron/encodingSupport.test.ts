import { EventEmitter } from 'events';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('child_process', () => ({ spawn: vi.fn() }));
vi.mock('./logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock('./processLifecycle', () => ({ createWorkloadSpawnOptions: (value: object) => value, terminateProcessTree: (child: { kill: () => void }) => child.kill() }));
import { spawn } from 'child_process';
import { explainNvencFailure, nvencEncoderOf, probeNvencEncoder } from './encodingSupport';
class FakeChild extends EventEmitter {
  stdout = { resume: vi.fn() }; stderr = new EventEmitter(); kill = vi.fn();
}
let child: FakeChild;
beforeEach(() => { vi.useFakeTimers(); child = new FakeChild(); vi.mocked(spawn).mockReset().mockReturnValue(child as never); });
afterEach(() => vi.useRealTimers());

describe('NVENC support', () => {
  it('preserves driver, format, session and unsupported-codec causes ahead of empty output', () => {
    expect(explainNvencFailure('[h264_nvenc] Driver does not support the required nvenc API version. Required: 13.1 Found: 13.0\nOutput file is empty')?.category).toBe('driver');
    expect(explainNvencFailure('[h264_nvenc] 10 bit encode not supported')?.category).toBe('format');
    expect(explainNvencFailure('[h264_nvenc] OpenEncodeSessionEx failed: out of memory (10)')?.category).toBe('sessions');
    expect(explainNvencFailure('[av1_nvenc] No capable devices found')?.message).toContain('CPU encoding');
    expect(explainNvencFailure('[hevc_nvenc] Cannot load libcuda.so.1')?.category).toBe('libraries');
    expect(explainNvencFailure("Unknown encoder 'av1_nvenc'")?.category).toBe('ffmpeg');
    expect(explainNvencFailure('CUDA_ERROR_OUT_OF_MEMORY in inference')).toBeNull();
  });
  it('checks the actual selected codec rather than assuming H.264 support implies AV1', async () => {
    const result = probeNvencEncoder('ffmpeg', 'av1_nvenc', 'vs.YUV420P10');
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args[args.indexOf('-c:v') + 1]).toBe('av1_nvenc');
    expect(args).toContain('format=yuv420p10le');
    child.stderr.emit('data', Buffer.from('[av1_nvenc] No capable devices found')); child.emit('close', 1);
    expect((await result).category).toBe('unsupported');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reports success only for a successful test encode', async () => {
    const result = probeNvencEncoder('ffmpeg', 'h264_nvenc', 'match_input'); child.emit('close', 0);
    expect((await result).available).toBe(true);
  });
  it('bounds timeout, spawn failure and cancellation, reaping the probe workload', async () => {
    const timed = probeNvencEncoder('ffmpeg', 'h264_nvenc', 'vs.YUV420P8', 100);
    await vi.advanceTimersByTimeAsync(100); expect((await timed).category).toBe('timeout'); expect(child.kill).toHaveBeenCalled();
    const failed = probeNvencEncoder('missing', 'hevc_nvenc', 'vs.YUV420P8'); child.emit('error', new Error('ENOENT'));
    expect((await failed).category).toBe('ffmpeg');
    const cancelled = probeNvencEncoder('ffmpeg', 'hevc_nvenc', 'vs.YUV420P8', 1000, () => true);
    await vi.advanceTimersByTimeAsync(50); expect((await cancelled).category).toBe('cancelled'); expect(vi.getTimerCount()).toBe(0);
  });
  it('respects the last explicit video encoder in custom arguments', () => {
    expect(nvencEncoderOf('-c:v libx264 -c:v hevc_nvenc')).toBe('hevc_nvenc');
    expect(nvencEncoderOf('-c:v av1_nvenc -c:v libx264')).toBeNull();
  });
});
