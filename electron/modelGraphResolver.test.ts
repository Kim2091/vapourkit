import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OnnxGraphInfo } from './onnxGraphInspector';
const mocks = vi.hoisted(() => ({ inspect: vi.fn(), exec: vi.fn(), stage: vi.fn().mockResolvedValue('/app data/vk_model_runtime.py') }));
vi.mock('./onnxGraphInspector', () => ({ inspectOnnxGraph: mocks.inspect }));
vi.mock('child_process', () => ({ execFile: mocks.exec }));
vi.mock('./trtexecShim', () => ({ ensureModelRuntimeScript: mocks.stage }));
vi.mock('./constants', () => ({ PATHS: { PYTHON: '/embedded/python.exe' } }));
import { inspectResolvedOnnxGraph } from './modelGraphResolver';
import { describeModel } from './modelContract';
const graph = (outputChannels: number | string): OnnxGraphInfo => ({
  inputs: [{ name: 'input', shape: ['batch', 3, 'h', 'w'], dataType: 'float16' }],
  outputs: [{ name: 'output', shape: ['batch', outputChannels, 'oh', 'ow'], dataType: 'float16' }],
  isStatic: false, externalData: [], weightDataTypes: ['float16'],
});
beforeEach(() => { mocks.inspect.mockReset(); mocks.exec.mockReset(); });
describe('resolved ONNX graph validation', () => {
  it('resolves Adore-style output symbols through the runtime helper before validating RGB', async () => {
    mocks.inspect.mockReturnValue(graph('Divoutput_dim_1'));
    mocks.exec.mockImplementation((_exe, _args, _options, done) => done(null, JSON.stringify(graph(3)), ''));
    const resolved = await inspectResolvedOnnxGraph('D:/models/Adore.onnx');
    expect(describeModel(resolved!).temporalFrames).toBe(1);
    expect(resolved!.outputShape).toEqual(['batch', 3, 'oh', 'ow']);
    expect(mocks.exec.mock.calls[0][1]).toEqual(['-I', '/app data/vk_model_runtime.py', '--inspect-bindings', 'D:/models/Adore.onnx']);
  });
  it('keeps numeric BF16/RGB imports independent of reference-runtime support', async () => {
    const original = graph(3); original.inputs[0].dataType = 'bfloat16';
    mocks.inspect.mockReturnValue(original);
    expect(await inspectResolvedOnnxGraph('model.onnx')).toBe(original);
    expect(mocks.exec).not.toHaveBeenCalled();
  });
  it('does not guess RGB when shape inference leaves a channel unresolved', async () => {
    mocks.inspect.mockReturnValue(graph('unknown'));
    mocks.exec.mockImplementation((_exe, _args, _options, done) => done(null, JSON.stringify(graph('unknown')), ''));
    const unresolved = await inspectResolvedOnnxGraph('custom.onnx');
    expect(() => describeModel(unresolved!)).toThrow('unresolved channels');
  });
  it('reports a failed inspection instead of treating an incomplete environment as compatible', async () => {
    mocks.inspect.mockReturnValue(graph('unknown'));
    mocks.exec.mockImplementation((_exe, _args, _options, done) => done(new Error('failed'), '', "No module named 'onnx'"));
    await expect(inspectResolvedOnnxGraph('model.onnx')).rejects.toThrow("No module named 'onnx'");
  });
});
