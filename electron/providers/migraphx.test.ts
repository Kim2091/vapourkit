import { describe, it, expect, vi, beforeEach } from 'vitest';

// constants.ts reads app paths at module scope.
vi.mock('electron', async () => {
  const p = await import('path');
  const o = await import('os');
  const root = p.join(o.tmpdir(), `vk-migraphx-test-${process.pid}`);
  return { app: { isPackaged: false, getAppPath: () => root, getPath: () => root } };
});

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const inspect = vi.fn();
vi.mock('../onnxGraphInspector', () => ({ inspectOnnxGraph: (p: string) => inspect(p) }));

import { migraphxProvider } from './migraphx';

describe('MIGraphX provider', () => {
  beforeEach(() => inspect.mockReset());

  it('compiles through vk_migx_model with the ONNX input name', () => {
    inspect.mockReturnValue({ inputName: 'lq', inputShape: [1, 3, 'h', 'w'], isStatic: false, weightDataTypes: [] });
    const code = migraphxProvider.modelCallCode('clip', 'C:\\models\\m_fp16.onnx', { numStreams: 2, useFp32: false });

    expect(code).toBe('clip = vk_migx_model(clip, "C:/models/m_fp16.onnx", input_name="lq", fp16=True, num_streams=2)\n');
  });

  it('builds FP32-imported models without --fp16', () => {
    inspect.mockReturnValue(null);
    const code = migraphxProvider.modelCallCode('[m1, clip, p1]', '/m/v.onnx', { numStreams: 1, useFp32: true });

    // An unreadable graph falls back to vsmlrt's default input name.
    expect(code).toBe('clip = vk_migx_model([m1, clip, p1], "/m/v.onnx", input_name="input", fp16=False, num_streams=1)\n');
  });

  it('refuses 5-D inputs up front, since vsmigx only runs 4-D programs', () => {
    inspect.mockReturnValue({ inputName: 'x', inputShape: [1, 5, 3, 'h', 'w'], isStatic: false, weightDataTypes: [] });
    const code = migraphxProvider.modelCallCode('[a, b]', '/m/vsr.onnx', { numStreams: 1, useFp32: false });

    expect(code).toMatch(/^raise vs\.Error\(".*4-D input.*vsr\.onnx has a 5-D input/);
    expect(code).not.toContain('vk_migx_model');
  });

  it('maps a TensorRT .engine path back to its ONNX', () => {
    expect(migraphxProvider.resolveModelFile('/m/model_fp16.engine')).toBe('/m/model_fp16.onnx');
  });

  it('pins the pip wheel on Linux only (Windows ships from the GitHub release)', () => {
    expect(migraphxProvider.pipPackages('win32')).toEqual([]);
    const linux = migraphxProvider.pipPackages('linux');
    if (process.arch === 'x64') {
      expect(linux).toEqual([expect.stringMatching(/^vapoursynth-mlrt-migx==\d/)]);
    } else {
      expect(linux).toEqual([]);
    }
  });
});
