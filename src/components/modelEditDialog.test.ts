import { describe, expect, it } from 'vitest';
import type { ModelFile } from '../electron.d';
import { editablePrecisions, formFromModel } from './ModelEditDialog';

const onnx: ModelFile = { id: 'a', name: 'A', path: '/m/a.onnx', precision: 'FP16', backend: 'onnx', category: 'Anime', modelType: 'vsr' };
const engine: ModelFile = { id: 'b', name: 'B', path: '/m/b.engine', precision: 'FP16', backend: 'tensorrt' };

describe('editablePrecisions', () => {
  it('offers BF16 for a TensorRT engine', () => {
    expect(editablePrecisions(engine, 'directml')).toEqual(['fp16', 'bf16', 'fp32']);
  });

  it('offers what an ONNX runtime can run for an ONNX file, whatever the app backend', () => {
    expect(editablePrecisions(onnx, 'directml')).toEqual(['fp16', 'fp32']);
    expect(editablePrecisions(onnx, 'tensorrt')).toEqual(['fp16', 'fp32']);
  });
});

describe('formFromModel', () => {
  it('starts from what the model list says', () => {
    expect(formFromModel(onnx)).toEqual({
      name: 'A', displayTag: '', description: '', categories: ['Anime'], modelType: 'vsr',
      temporalFrames: undefined, useFp32: false, useBf16: false,
    });
    expect(formFromModel(engine).modelType).toBe('image');
  });
});
