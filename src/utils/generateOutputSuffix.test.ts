import { describe, it, expect } from 'vitest';
import { generateOutputSuffix } from './generateOutputSuffix';
import type { Filter } from '../electron.d';

describe('generateOutputSuffix', () => {
  it('returns processed when no operations are applied', () => {
    const result = generateOutputSuffix({
      colorimetry: {},
      filters: [],
      segment: { enabled: false, startFrame: 0, endFrame: -1 },
      selectedModel: null,
    });
    expect(result).toBe('processed');
  });

  it('includes colorimetry tag when enabled', () => {
    const result = generateOutputSuffix({
      colorimetry: { overwriteMatrix: true },
      filters: [],
      segment: { enabled: false, startFrame: 0, endFrame: -1 },
      selectedModel: null,
    });
    expect(result).toBe('colorimetry');
  });

  it('includes custom filter tags', () => {
    const filters: Filter[] = [
      { id: '1', enabled: true, filterType: 'custom', preset: 'DPIR Denoise_Deblock', code: '', order: 0, category: 'Denoise/Deblock' },
      { id: '2', enabled: true, filterType: 'custom', preset: 'CAS Sharpen', code: '', order: 1, category: 'Sharpen/Detail' },
    ];
    const result = generateOutputSuffix({
      colorimetry: {},
      filters,
      segment: { enabled: false, startFrame: 0, endFrame: -1 },
      selectedModel: null,
    });
    expect(result).toBe('denoise_sharpen');
  });

  it('extracts AI model scale from model path', () => {
    const filters: Filter[] = [
      { id: '1', enabled: true, filterType: 'aiModel', preset: 'AI Model', code: '', order: 0, modelPath: 'C:/models/4x-AnimeSharp.onnx' },
    ];
    const result = generateOutputSuffix({
      colorimetry: {},
      filters,
      segment: { enabled: false, startFrame: 0, endFrame: -1 },
      selectedModel: null,
    });
    expect(result).toBe('4x');
  });

  it('falls back to upscale when scale cannot be inferred', () => {
    const filters: Filter[] = [
      { id: '1', enabled: true, filterType: 'aiModel', preset: 'AI Model', code: '', order: 0, modelPath: 'C:/models/MyModel.onnx' },
    ];
    const result = generateOutputSuffix({
      colorimetry: {},
      filters,
      segment: { enabled: false, startFrame: 0, endFrame: -1 },
      selectedModel: null,
    });
    expect(result).toBe('upscale');
  });

  it('includes resize tag when output resolution differs from input', () => {
    const filters: Filter[] = [
      { id: '1', enabled: true, filterType: 'aiModel', preset: 'AI Model', code: '', order: 0, modelPath: 'C:/models/2x-Model.onnx' },
    ];
    const result = generateOutputSuffix(
      {
        colorimetry: {},
        filters,
        segment: { enabled: false, startFrame: 0, endFrame: -1 },
        selectedModel: null,
      },
      {
        inputResolution: '1920x1080',
        outputResolution: '3840x2160',
      }
    );
    expect(result).toBe('2x_resize2160');
  });

  it('estimates resize height from input resolution and scale', () => {
    const filters: Filter[] = [
      { id: '1', enabled: true, filterType: 'aiModel', preset: 'AI Model', code: '', order: 0, modelPath: 'C:/models/2x-Model.onnx' },
    ];
    const result = generateOutputSuffix(
      {
        colorimetry: {},
        filters,
        segment: { enabled: false, startFrame: 0, endFrame: -1 },
        selectedModel: null,
      },
      {
        inputResolution: '1920x1080',
      }
    );
    expect(result).toBe('2x_resize2160');
  });

  it('includes trim tag when segment is enabled', () => {
    const result = generateOutputSuffix({
      colorimetry: {},
      filters: [],
      segment: { enabled: true, startFrame: 100, endFrame: 500 },
      selectedModel: null,
    });
    expect(result).toBe('trim');
  });

  it('produces the example from the spec', () => {
    const filters: Filter[] = [
      { id: '1', enabled: true, filterType: 'custom', preset: 'DPIR Denoise_Deblock', code: '', order: 0, category: 'Denoise/Deblock' },
      { id: '2', enabled: true, filterType: 'aiModel', preset: 'AI Model', code: '', order: 1, modelPath: 'C:/models/4x_RealESRGAN.onnx' },
    ];
    const result = generateOutputSuffix(
      {
        colorimetry: { overwriteMatrix: true },
        filters,
        segment: { enabled: false, startFrame: 0, endFrame: -1 },
        selectedModel: null,
      },
      {
        inputResolution: '1920x1080',
        outputResolution: '3840x2160',
      }
    );
    expect(result).toContain('colorimetry');
    expect(result).toContain('denoise');
    expect(result).toContain('4x');
    expect(result).toContain('resize');
  });

  it('truncates suffixes longer than 32 characters', () => {
    const filters: Filter[] = Array.from({ length: 10 }, (_, i) => ({
      id: `${i}`,
      enabled: true,
      filterType: 'custom' as const,
      preset: `Filter${i}`,
      code: '',
      order: i,
      category: 'Sharpen/Detail',
    }));
    const result = generateOutputSuffix({
      colorimetry: {},
      filters,
      segment: { enabled: false, startFrame: 0, endFrame: -1 },
      selectedModel: null,
    });
    expect(result.length).toBeLessThanOrEqual(32);
  });

  it('deduplicates consecutive identical tags', () => {
    const filters: Filter[] = [
      { id: '1', enabled: true, filterType: 'custom', preset: 'DPIR', code: '', order: 0, category: 'Denoise/Deblock' },
      { id: '2', enabled: true, filterType: 'custom', preset: 'KNLMeans', code: '', order: 1, category: 'Denoise/Deblock' },
    ];
    const result = generateOutputSuffix({
      colorimetry: {},
      filters,
      segment: { enabled: false, startFrame: 0, endFrame: -1 },
      selectedModel: null,
    });
    expect(result).toBe('denoise');
  });

  it('uses selectedModel when no aiModel filter is present', () => {
    const result = generateOutputSuffix({
      colorimetry: {},
      filters: [],
      segment: { enabled: false, startFrame: 0, endFrame: -1 },
      selectedModel: 'C:/models/2x-AnimeSharp.onnx',
    });
    expect(result).toBe('2x');
  });
});
