import { describe, expect, it } from 'vitest';
import {
  getBackendsForPlatform,
  getDefaultBackendForPlatform,
  normalizeBackendForPlatform,
} from './descriptors';

describe('backend platform policy', () => {
  it('exposes only supported backends on Linux', () => {
    expect(getBackendsForPlatform('linux').map(backend => backend.id)).toEqual(['tensorrt', 'ncnn']);
  });

  it('migrates a Windows-only DirectML value to Linux NCNN', () => {
    expect(normalizeBackendForPlatform('directml', 'linux')).toBe('ncnn');
  });

  it('preserves Linux-compatible backend values', () => {
    expect(normalizeBackendForPlatform('tensorrt', 'linux')).toBe('tensorrt');
    expect(normalizeBackendForPlatform('ncnn', 'linux')).toBe('ncnn');
  });

  it('does not classify unsupported platforms as Linux', () => {
    expect(getBackendsForPlatform('darwin')).toEqual([]);
    expect(() => getDefaultBackendForPlatform('darwin')).toThrow('Unsupported platform');
  });
});
