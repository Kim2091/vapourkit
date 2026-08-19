import { describe, it, expect } from 'vitest';
import {
  precisionFromName,
  hasPrecisionSuffix,
  withPrecisionSuffix,
  precisionOf,
  resolveModelPrecision,
} from './modelPrecision';

describe('precisionFromName', () => {
  it('reads a separated token anywhere in the name', () => {
    expect(precisionFromName('s442czel45frcb33_3_bf16')).toBe('bf16');
    expect(precisionFromName('2x_CelPrime_V5.2_FRDMU_17k_540x720_bf16_static_540x720')).toBe('bf16');
    expect(precisionFromName('2x_bndl_animefilm_v1.5_DAT2.safetensors_dyn-HW_strong_bf16_op20')).toBe('bf16');
    expect(precisionFromName('2x-AnimeSharpV4_Fast_fp16.onnx')).toBe('fp16');
    expect(precisionFromName('1x-AniRestore_TFDAT_fp32')).toBe('fp32');
  });

  it('takes the last token, which is the one a build appended', () => {
    expect(precisionFromName('2x_AniSD_AC_SPAN_fp32_fp16')).toBe('fp16');
  });

  it('ignores tokens that are part of a longer word', () => {
    expect(precisionFromName('mybf16model')).toBeUndefined();
    expect(precisionFromName('2x_Model_fp16x')).toBeUndefined();
    expect(precisionFromName('2x_AnimeJaNai_V2_UltraCompact')).toBeUndefined();
  });

  it('reports whether a name declares a precision at all', () => {
    expect(hasPrecisionSuffix('2x_Model_bf16')).toBe(true);
    expect(hasPrecisionSuffix('2x_Model')).toBe(false);
  });
});

describe('withPrecisionSuffix', () => {
  it('appends the precision when the name does not declare one', () => {
    expect(withPrecisionSuffix('2x_Model', 'bf16')).toBe('2x_Model_bf16');
    expect(withPrecisionSuffix('2x_Model', 'fp16')).toBe('2x_Model_fp16');
  });

  it('leaves a declared name alone so the engine pairs with its ONNX', () => {
    expect(withPrecisionSuffix('2x_Model_bf16_op20', 'bf16')).toBe('2x_Model_bf16_op20');
    expect(withPrecisionSuffix(withPrecisionSuffix('2x_Model', 'bf16'), 'bf16')).toBe('2x_Model_bf16');
  });
});

describe('precisionOf', () => {
  it('maps the build flags, FP32 winning over BF16', () => {
    expect(precisionOf(false, false)).toBe('fp16');
    expect(precisionOf(false, true)).toBe('bf16');
    expect(precisionOf(true, false)).toBe('fp32');
    expect(precisionOf(true, true)).toBe('fp32');
  });
});

describe('resolveModelPrecision', () => {
  it('lets the model name override the graph', () => {
    // Curated BF16 models ship FP32 weights and FP32 I/O; only the name says BF16
    expect(resolveModelPrecision({
      modelName: 's442czel45frcb33_3_bf16',
      weightDataTypes: ['float32'],
      inputDataType: 'float32',
    })).toBe('bf16');
  });

  it('falls back to the weights, which carry the precision the I/O does not', () => {
    expect(resolveModelPrecision({
      modelName: '2x_SomeModel',
      weightDataTypes: ['bfloat16', 'float32', 'int64'],
      inputDataType: 'float32',
    })).toBe('bf16');
    expect(resolveModelPrecision({
      modelName: '2x_SomeModel',
      weightDataTypes: ['float16'],
      inputDataType: 'float32',
    })).toBe('fp16');
  });

  it('falls back to the input type when nothing else says', () => {
    expect(resolveModelPrecision({ modelName: '2x_SomeModel', inputDataType: 'float32' })).toBe('fp32');
    expect(resolveModelPrecision({ modelName: '2x_SomeModel', inputDataType: 'float16' })).toBe('fp16');
    expect(resolveModelPrecision({ modelName: '2x_SomeModel', inputDataType: 'bfloat16' })).toBe('bf16');
  });

  it('answers undefined when nothing is known, leaving the choice to the user', () => {
    expect(resolveModelPrecision({ modelName: '2x_SomeModel' })).toBeUndefined();
    expect(resolveModelPrecision({})).toBeUndefined();
  });
});
