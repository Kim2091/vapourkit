import { describe, it, expect, vi } from 'vitest';

// Mock the logger to avoid file I/O during tests
vi.mock('./logger', () => ({
  logger: {
    error: vi.fn(),
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
