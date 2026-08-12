import { describe, expect, it } from 'vitest';
import { formatVapourSynthValidationError } from './vapourSynthErrorFormatter';

describe('formatVapourSynthValidationError', () => {
  it('removes API3 plugin deprecation notices while preserving the actual error', () => {
    const output = [
      'Warning: Plugin C:\\plugins\\autocrop.dll is using API3 which is deprecated and will be removed shortly.',
      'Warning: Plugin C:\\plugins\\fgrain_cuda.dll is using API3 which is deprecated and will be removed shortly.',
      'Script evaluation failed:',
      'Python exception: ModuleNotFoundError: No module named \'vs_undistort\'',
    ].join('\r\n');

    expect(formatVapourSynthValidationError(output)).toBe(
      "Script evaluation failed:\nPython exception: ModuleNotFoundError: No module named 'vs_undistort'",
    );
  });

  it('preserves other warnings that may help diagnose the failure', () => {
    const output = [
      'Warning: Plugin C:\\plugins\\autocrop.dll is using API3 which is deprecated and will be removed shortly.',
      'Warning: model file is missing',
      'Script evaluation failed',
    ].join('\n');

    expect(formatVapourSynthValidationError(output)).toBe(
      'Warning: model file is missing\nScript evaluation failed',
    );
  });

  it('uses a concise fallback when startup notices are the only output', () => {
    const output = 'Warning: Plugin C:\\plugins\\autocrop.dll is using API3 which is deprecated and will be removed shortly.';

    expect(formatVapourSynthValidationError(output)).toBe(
      'VapourSynth failed before producing output. Check the log for details.',
    );
  });
});
