import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs-extra', () => ({
  existsSync: vi.fn(),
}));

vi.mock('./utils', () => ({
  resolveHostCommand: vi.fn(),
}));

import * as fs from 'fs-extra';
import { resolveHostCommand } from './utils';
import {
  getVideoCompareUnavailableMessage,
  isVideoCompareAvailable,
  resolveVideoCompareCommand,
} from './videoCompare';

describe('video-compare availability', () => {
  beforeEach(() => {
    vi.mocked(resolveHostCommand).mockReset();
    vi.mocked(fs.existsSync).mockReset();
  });

  it('resolves the optional Linux command through PATH without probing it', async () => {
    vi.mocked(resolveHostCommand).mockReturnValue('/home/linuxbrew/.linuxbrew/bin/video-compare');

    await expect(isVideoCompareAvailable('video-compare', 'linux')).resolves.toBe(true);
    expect(resolveHostCommand).toHaveBeenCalledWith('video-compare');
    expect(resolveVideoCompareCommand('video-compare', 'linux')).toBe('/home/linuxbrew/.linuxbrew/bin/video-compare');
  });

  it('keeps the app-managed Windows executable check', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    await expect(isVideoCompareAvailable('C:/data/video-compare.exe', 'win32')).resolves.toBe(true);
    expect(fs.existsSync).toHaveBeenCalledWith('C:/data/video-compare.exe');
    expect(resolveHostCommand).not.toHaveBeenCalled();
  });

  it('explains that video comparison is optional on Linux', () => {
    expect(getVideoCompareUnavailableMessage('linux')).toContain('optional on Linux');
  });
});
