import { describe, it, expect } from 'vitest';
import {
  parseFfmpegArgs,
  generateFfmpegArgs,
  getRecommendedCrfRange,
  getAvailablePresets,
  getDefaultPreset,
  getPresetDisplayName,
  supportsCrf,
  supportsPreset,
  getAvailableEncoders,
  getEncoderDisplayName,
  getEncoderShortName,
  type FfmpegConfig,
} from './ffmpegConfig';

describe('parseFfmpegArgs', () => {
  it('parses basic h264 software args', () => {
    const result = parseFfmpegArgs('-c:v libx264 -preset medium -crf 18');
    expect(result.codec).toBe('h264');
    expect(result.encoder).toBe('software');
    expect(result.preset).toBe('medium');
    expect(result.crf).toBe(18);
  });

  it('parses NVENC h265 args', () => {
    const result = parseFfmpegArgs('-c:v hevc_nvenc -preset p7 -crf 20');
    expect(result.codec).toBe('h265');
    expect(result.encoder).toBe('nvidia');
    expect(result.preset).toBe('p7');
    expect(result.crf).toBe(20);
  });

  it('parses AV1 software args', () => {
    const result = parseFfmpegArgs('-c:v libsvtav1 -preset 8 -crf 25');
    expect(result.codec).toBe('av1');
    expect(result.encoder).toBe('software');
    expect(result.preset).toBe('8');
    expect(result.crf).toBe(25);
  });

  it('detects custom codec as custom', () => {
    const result = parseFfmpegArgs('-c:v rawvideo');
    expect(result.codec).toBe('custom');
  });

  it('returns defaults when no args match', () => {
    const result = parseFfmpegArgs('');
    expect(result.codec).toBe('h264');
    expect(result.encoder).toBe('software');
  });

  it('marks args with extra flags as custom', () => {
    const result = parseFfmpegArgs('-c:v libx264 -preset medium -crf 18 -b:v 5M');
    expect(result.codec).toBe('custom');
    expect(result.customArgs).toBeDefined();
  });
});

describe('generateFfmpegArgs', () => {
  it('generates h264 software args', () => {
    const config: FfmpegConfig = { codec: 'h264', encoder: 'software', preset: 'medium', crf: 18 };
    const result = generateFfmpegArgs(config);
    expect(result).toContain('-c:v libx264');
    expect(result).toContain('-preset medium');
    expect(result).toContain('-crf 18');
  });

  it('generates h265 nvidia args', () => {
    const config: FfmpegConfig = { codec: 'h265', encoder: 'nvidia', preset: 'p7', crf: 20 };
    const result = generateFfmpegArgs(config);
    expect(result).toContain('-c:v hevc_nvenc');
    expect(result).toContain('-preset p7');
  });

  it('omits preset and CRF for ProRes', () => {
    const config: FfmpegConfig = { codec: 'prores', encoder: 'software', preset: 'medium', crf: 18 };
    const result = generateFfmpegArgs(config);
    expect(result).toContain('-c:v prores_ks');
    expect(result).not.toContain('-preset');
    expect(result).not.toContain('-crf');
  });

  it('returns custom args when codec is custom', () => {
    const config: FfmpegConfig = { codec: 'custom', encoder: 'software', preset: 'medium', crf: 18, customArgs: '-c:v rawvideo' };
    expect(generateFfmpegArgs(config)).toBe('-c:v rawvideo');
  });
});

describe('getRecommendedCrfRange', () => {
  it('returns correct range for h264', () => {
    const range = getRecommendedCrfRange('h264');
    expect(range).toEqual({ min: 0, max: 51, default: 18 });
  });

  it('returns correct range for h265', () => {
    expect(getRecommendedCrfRange('h265').default).toBe(20);
  });

  it('returns correct range for av1', () => {
    const range = getRecommendedCrfRange('av1');
    expect(range.max).toBe(63);
    expect(range.default).toBe(25);
  });
});

describe('getAvailablePresets', () => {
  it('returns NVENC presets for nvidia', () => {
    const presets = getAvailablePresets('h264', 'nvidia');
    expect(presets).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
  });

  it('returns AMF presets for amd', () => {
    const presets = getAvailablePresets('h264', 'amd');
    expect(presets).toEqual(['speed', 'balanced', 'quality']);
  });

  it('returns numeric presets for software av1', () => {
    const presets = getAvailablePresets('av1', 'software');
    expect(presets).toHaveLength(13); // 0-12
    expect(presets[0]).toBe('0');
    expect(presets[12]).toBe('12');
  });

  it('returns single preset for prores', () => {
    expect(getAvailablePresets('prores', 'software')).toEqual(['medium']);
  });
});

describe('getDefaultPreset', () => {
  it('returns medium for software h264', () => {
    expect(getDefaultPreset('software', 'h264')).toBe('medium');
  });

  it('returns 8 for software av1', () => {
    expect(getDefaultPreset('software', 'av1')).toBe('8');
  });

  it('returns p7 for nvidia', () => {
    expect(getDefaultPreset('nvidia')).toBe('p7');
  });

  it('returns quality for amd', () => {
    expect(getDefaultPreset('amd')).toBe('quality');
  });

  it('returns veryslow for intel', () => {
    expect(getDefaultPreset('intel')).toBe('veryslow');
  });
});

describe('getPresetDisplayName', () => {
  it('maps NVENC low presets to Fastest', () => {
    expect(getPresetDisplayName('p1')).toBe('Fastest');
    expect(getPresetDisplayName('p2')).toBe('Fastest');
  });

  it('maps NVENC high presets to Best Quality', () => {
    expect(getPresetDisplayName('p5')).toBe('Best Quality');
    expect(getPresetDisplayName('p7')).toBe('Best Quality');
  });

  it('maps SVT-AV1 numeric presets', () => {
    expect(getPresetDisplayName('0')).toBe('Best Quality');
    expect(getPresetDisplayName('8')).toBe('Fast Encode');
    expect(getPresetDisplayName('12')).toBe('Fastest');
  });

  it('maps AMF presets', () => {
    expect(getPresetDisplayName('speed')).toBe('Fast Encode');
    expect(getPresetDisplayName('quality')).toBe('Best Quality');
  });

  it('maps standard x264 presets', () => {
    expect(getPresetDisplayName('ultrafast')).toBe('Fast Encode');
    expect(getPresetDisplayName('medium')).toBe('Balanced');
    expect(getPresetDisplayName('veryslow')).toBe('Best Quality');
  });
});

describe('supportsCrf', () => {
  it('returns true for h264, h265, av1', () => {
    expect(supportsCrf('h264')).toBe(true);
    expect(supportsCrf('h265')).toBe(true);
    expect(supportsCrf('av1')).toBe(true);
  });

  it('returns false for prores and custom', () => {
    expect(supportsCrf('prores')).toBe(false);
    expect(supportsCrf('custom')).toBe(false);
  });
});

describe('supportsPreset', () => {
  it('returns false for prores', () => {
    expect(supportsPreset('prores')).toBe(false);
  });
});

describe('getAvailableEncoders', () => {
  it('returns all encoders for h264/h265/av1', () => {
    expect(getAvailableEncoders('h264')).toEqual(['software', 'nvidia', 'amd', 'intel']);
  });

  it('returns only software for prores', () => {
    expect(getAvailableEncoders('prores')).toEqual(['software']);
  });
});

describe('getEncoderDisplayName', () => {
  it('returns correct display names', () => {
    expect(getEncoderDisplayName('software')).toBe('CPU (Software)');
    expect(getEncoderDisplayName('nvidia')).toBe('NVIDIA (NVENC)');
  });
});

describe('getEncoderShortName', () => {
  it('returns correct short names', () => {
    expect(getEncoderShortName('software')).toBe('CPU');
    expect(getEncoderShortName('nvidia')).toBe('NVIDIA');
  });
});
