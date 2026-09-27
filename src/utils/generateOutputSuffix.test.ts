import { describe, it, expect } from 'vitest';
import { generateOutputSuffix, modelTag } from './generateOutputSuffix';
import type { Filter } from '../electron.d';

let order = 0;
const custom = (preset: string, category: string | string[], enabled = true): Filter =>
  ({ id: preset, enabled, filterType: 'custom', preset, code: '', order: order++, category });
const model = (modelPath?: string, enabled = true): Filter =>
  ({ id: modelPath ?? 'm', enabled, filterType: 'aiModel', preset: 'AI Model', code: '', order: order++, modelPath });
const noSegment = { enabled: false, startFrame: 0, endFrame: -1 };

describe('generateOutputSuffix', () => {
  it('returns processed when nothing is applied', () => {
    expect(generateOutputSuffix({ colorimetry: {}, filters: [], segment: noSegment })).toBe('processed');
  });

  it('tags filters from the categories the shipped templates actually use', () => {
    const filters = [
      custom('QTGMC (New)', 'Deinterlacing'),
      custom('DFTTest2', ['Hybrid', 'Denoising']),
      custom('CAS Sharpen', 'Sharpening'),
      custom('Color Grade', ['Color Modification']),
    ];
    expect(generateOutputSuffix({ filters })).toBe('deint_denoise_sharpen_color');
  });

  it('follows the chain order, not the order steps were grouped in', () => {
    const filters = [custom('Crop', ['Padding/Cropping']), model('C:/m/2x-AnimeSharp.onnx'), custom('KNLMeans Denoise', 'Denoising')];
    expect(generateOutputSuffix({ filters: [...filters].reverse() })).toBe('crop_2xanimesharp_denoise');
  });

  it('leaves out steps that do not describe the result', () => {
    const filters = [custom('Detail Mask', 'Masking'), custom('Modulus', 'Utility'), custom('Stack', 'Comparison'), custom('CAS', 'Sharpening')];
    expect(generateOutputSuffix({ filters })).toBe('sharpen');
  });

  it("falls back to the filter's whole name, not its first word", () => {
    expect(generateOutputSuffix({ filters: [custom('Wavelet Color Fix from Step', 'Something New')] })).toBe('waveletcolorfixfromstep');
  });

  it('ignores disabled steps and a model step with no model', () => {
    const filters = [custom('Denoise', 'Denoising', false), model(undefined), model('C:/m/4x-Foo.onnx', false)];
    expect(generateOutputSuffix({ filters })).toBe('processed');
  });

  it('names a model by its file, without the build details', () => {
    expect(modelTag('C:/models/2x_bndl_animefilm_v3_1x27xHxW_dyn-HW_fp32_op20.engine')).toBe('2xbndlanimefilmv3');
    expect(modelTag('C:/models/4x-AnimeSharp_fp16.onnx')).toBe('4xanimesharp');
    expect(modelTag('C:/models/RealESRGAN_x4plus.onnx')).toBe('realesrganx4plus');
    expect(modelTag('C:/models/fp16.onnx')).toBe('model');
  });

  it('adds the output height only when the evaluated output differs from the source', () => {
    const filters = [model('C:/m/2x-Model.onnx')];
    expect(generateOutputSuffix({ filters }, { inputResolution: '1920x1080', outputResolution: '3840x2160' })).toBe('2xmodel_2160p');
    expect(generateOutputSuffix({ filters }, { inputResolution: '1920x1080', outputResolution: '1920x1080' })).toBe('2xmodel');
  });

  it('never guesses a resolution it has not been told', () => {
    expect(generateOutputSuffix({ filters: [model('C:/m/2x-Model.onnx')] }, { inputResolution: '1920x1080' })).toBe('2xmodel');
  });

  it('gives the full size when the shape changes', () => {
    expect(generateOutputSuffix({ filters: [custom('Crop', ['Padding/Cropping'])] }, { inputResolution: '1920x1080', outputResolution: '1440x1080' }))
      .toBe('crop_1440x1080');
  });

  it('adds the output frame rate when it changes', () => {
    const filters = [custom('QTGMC (New)', 'Deinterlacing')];
    expect(generateOutputSuffix({ filters }, { inputFps: '29.97', outputFps: '59.94' })).toBe('deint_59.94fps');
    expect(generateOutputSuffix({ filters }, { inputFps: 23.976, outputFps: 23.976 })).toBe('deint');
  });

  it('includes colorimetry first and trim last', () => {
    expect(generateOutputSuffix({ colorimetry: { overwriteMatrix: true }, filters: [custom('CAS', 'Sharpening')], segment: { enabled: true, startFrame: 1, endFrame: 9 } }))
      .toBe('colorimetry_sharpen_trim');
  });

  it('says each thing once', () => {
    const filters = [custom('A', 'Denoising'), custom('B', 'Sharpening'), custom('C', 'Denoising')];
    expect(generateOutputSuffix({ filters })).toBe('denoise_sharpen');
  });

  it('drops whole trailing steps to fit, and keeps the facts about the result', () => {
    const filters = Array.from({ length: 12 }, (_, i) => custom(`Filter Number ${i}`, `Category ${i}`));
    const suffix = generateOutputSuffix({ filters }, { inputResolution: '720x480', outputResolution: '1440x960' });
    expect(suffix.length).toBeLessThanOrEqual(64);
    expect(suffix.endsWith('_960p')).toBe(true);
    for (const tag of suffix.split('_').slice(0, -1)) expect(tag).toMatch(/^filternumber\d+$/);
  });

  it('never contains a dash, which the output path treats as the start of the suffix', () => {
    expect(generateOutputSuffix({ filters: [model('C:/m/4x-Some-Model-Name.onnx')] })).not.toContain('-');
  });
});

describe('generateOutputSuffix, named exceptions', () => {
  it('leaves out Modulus, which only pads for the model, and names Balance Borders for what it does', () => {
    expect(generateOutputSuffix({ filters: [custom('Modulus', ['Padding/Cropping']), custom('Balance Borders', ['Hybrid', 'Padding/Cropping'])] }))
      .toBe('borders');
  });

  it('tags interpolation, grain and chroma steps', () => {
    expect(generateOutputSuffix({ filters: [custom('RIFE', 'Frame Interpolation'), custom('FGrain', ['Grain']), custom('Fix Chroma Bleeding', ['Hybrid', 'Chroma'])] }))
      .toBe('interp_grain_chroma');
  });
});
