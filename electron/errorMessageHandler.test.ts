import { describe, it, expect, vi } from 'vitest';

// Mock the logger to avoid file I/O during tests
vi.mock('./logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    getLogPath: () => '/mock/log/path.log',
  },
}));

import { ErrorMessageHandler } from './errorMessageHandler';

describe('ErrorMessageHandler.extractErrorMessage', () => {
  it('returns unknown error for empty stderr', () => {
    expect(ErrorMessageHandler.extractErrorMessage('')).toBe('Unknown error (no error details available)');
  });

  it('returns unknown error for whitespace-only stderr', () => {
    expect(ErrorMessageHandler.extractErrorMessage('   \n  ')).toBe('Unknown error (no error details available)');
  });

  it('explains a MIGraphX HIP runtime that cannot load (the process dies with no traceback)', () => {
    // Captured from a real run on a machine without an AMD driver
    const stderr = 'Warning: Plugin C:\\p\\migx\\vsmigx.dll is using API3 which is deprecated and will be removed shortly.\n' +
      'vsmigx: failed to preload C:\\p\\migx\\vsmlrt-hip\\amdhip64_6.dll\n';
    expect(ErrorMessageHandler.extractErrorMessage(stderr)).toMatch(/^MIGraphX could not start the AMD HIP runtime\..*DirectML or NCNN\.$/);
  });

  it('extracts Error: pattern', () => {
    const stderr = 'Some output\nError: Could not open file\nMore output';
    expect(ErrorMessageHandler.extractErrorMessage(stderr)).toBe('Could not open file');
  });

  it('extracts Failed to retrieve frame pattern', () => {
    const stderr = 'Failed to retrieve frame 42 with error: Memory allocation failed';
    expect(ErrorMessageHandler.extractErrorMessage(stderr)).toBe('Memory allocation failed');
  });

  it('extracts Exception: pattern', () => {
    const stderr = 'Exception: Invalid model format';
    expect(ErrorMessageHandler.extractErrorMessage(stderr)).toBe('Invalid model format');
  });

  it('clips long error messages to maxLength', () => {
    const longError = 'Error: ' + 'x'.repeat(500);
    const result = ErrorMessageHandler.extractErrorMessage(longError, 50);
    expect(result.length).toBeLessThanOrEqual(53); // 50 + '...'
    expect(result.endsWith('...')).toBe(true);
  });

  it('falls back to last lines when no pattern matches', () => {
    const stderr = 'line 1\nline 2\nline 3\nline 4\nline 5';
    const result = ErrorMessageHandler.extractErrorMessage(stderr);
    expect(result).toContain('line 5');
    expect(result).toContain('line 4');
    expect(result).toContain('line 3');
  });

  it('clips fallback lines to maxLength', () => {
    const longLines = 'a'.repeat(200) + '\n' + 'b'.repeat(200);
    const result = ErrorMessageHandler.extractErrorMessage(longLines, 100);
    expect(result.length).toBeLessThanOrEqual(103);
  });

  it('respects custom maxLength parameter', () => {
    const stderr = 'Error: ' + 'a'.repeat(1000);
    const result = ErrorMessageHandler.extractErrorMessage(stderr, 100);
    expect(result.length).toBeLessThanOrEqual(103);
  });
});

describe('ErrorMessageHandler.formatUserErrorMessage', () => {
  it('formats error type and detail', () => {
    const result = ErrorMessageHandler.formatUserErrorMessage('VapourSynth Error', 'Script failed');
    expect(result).toContain('VapourSynth Error: Script failed');
  });

  it('includes log path guidance', () => {
    const result = ErrorMessageHandler.formatUserErrorMessage('FFmpeg Error', 'Encoding failed');
    expect(result).toContain('log file');
    expect(result).toContain('/mock/log/path.log');
  });
});

describe('ErrorMessageHandler.extractErrorMessage: noise and NVENC', () => {
  const api3 = (dll: string) =>
    `Warning: Plugin c:\program files\vapourkit\data\vapoursynth-portable\Lib\site-packages\vapoursynth\plugins\${dll} is using API3 which is deprecated and will be removed shortly.`;

  it('never reports the API3 autoload notices as the error', () => {
    const stderr = [api3('vsncnn.dll'), api3('vsnlm_cuda.dll'), api3('wnnm.dll'), ''].join('\r\n');
    const result = ErrorMessageHandler.extractErrorMessage(stderr);
    expect(result).not.toContain('API3');
    expect(result).toContain('stopped without printing an error');
  });

  it('finds the real error behind the notices', () => {
    const stderr = [api3('vsncnn.dll'), 'Script evaluation failed:', 'Python exception: No module named vsmlrt'].join('\n');
    expect(ErrorMessageHandler.extractErrorMessage(stderr)).not.toContain('API3');
  });

  it('explains an NVIDIA driver too old for NVENC instead of "Output file is empty"', () => {
    const stderr = [
      '[h264_nvenc @ 000002bc1db72000] Driver does not support the required nvenc API version. Required: 13.1 Found: 13.0',
      '[h264_nvenc @ 000002bc1db72000] The minimum required Nvidia driver for nvenc is 610.00 or newer',
      '[out#1/image2pipe @ 000002bc1c0f7300] Output file is empty, nothing was encoded',
      'Conversion failed!',
    ].join('\r\n');
    const result = ErrorMessageHandler.extractErrorMessage(stderr);
    expect(result).toContain('NVIDIA driver is too old');
    expect(result).toContain('610 or newer');
  });
});

