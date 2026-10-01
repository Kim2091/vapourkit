import { describe, expect, it, vi } from 'vitest';

vi.mock('./logger', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

import { describeNvencDriverError, parseNvencDriverError } from './nvencCheck';

// Verbatim from a user's failed encode (RTX 5080, pre-610 driver)
const FFMPEG_STDERR = [
  'Stream mapping:',
  '  Stream #0:0 -> #0:0 (rawvideo (native) -> h264 (h264_nvenc))',
  '[h264_nvenc @ 000002bc1db72000] Driver does not support the required nvenc API version. Required: 13.1 Found: 13.0',
  '[h264_nvenc @ 000002bc1db72000] The minimum required Nvidia driver for nvenc is 610.00 or newer',
  '[vost#0:0/h264_nvenc @ 000002bc1db71d80] [enc:h264_nvenc @ 000002bc1c014980] Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.',
  '[out#1/image2pipe @ 000002bc1c0f7300] Output file is empty, nothing was encoded',
].join('\r\n');

describe('parseNvencDriverError', () => {
  it('reads the versions and the minimum driver', () => {
    expect(parseNvencDriverError(FFMPEG_STDERR)).toEqual({ required: '13.1', found: '13.0', minDriver: '610.00' });
  });

  it('is null for any other ffmpeg failure', () => {
    expect(parseNvencDriverError('[h264_nvenc] No capable devices found')).toBeNull();
    expect(parseNvencDriverError('')).toBeNull();
  });
});

describe('describeNvencDriverError', () => {
  it('names the driver to install and the way around it', () => {
    const message = describeNvencDriverError({ required: '13.1', found: '13.0', minDriver: '610.00' });
    expect(message).toContain('to 610 or newer');
    expect(message).toContain('CPU encoder');
  });
});
