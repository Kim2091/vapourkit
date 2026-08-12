import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs-extra', () => ({
  existsSync: vi.fn(),
}));

vi.mock('./utils', () => ({
  isCommandAvailable: vi.fn(),
}));

import * as fs from 'fs-extra';
import { isCommandAvailable } from './utils';
import {
  getVideoCompareUnavailableMessage,
  isVideoCompareAvailable,
} from './videoCompare';

describe('video-compare availability', () => {
  beforeEach(() => {
    vi.mocked(isCommandAvailable).mockReset();
    vi.mocked(fs.existsSync).mockReset();
  });

  it('resolves the optional Linux command through PATH', async () => {
    vi.mocked(isCommandAvailable).mockResolvedValue(true);

    await expect(isVideoCompareAvailable('video-compare', 'linux')).resolves.toBe(true);
    expect(isCommandAvailable).toHaveBeenCalledWith('video-compare');
  });

  it('keeps the app-managed Windows executable check', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    await expect(isVideoCompareAvailable('C:/data/video-compare.exe', 'win32')).resolves.toBe(true);
    expect(fs.existsSync).toHaveBeenCalledWith('C:/data/video-compare.exe');
    expect(isCommandAvailable).not.toHaveBeenCalled();
  });

  it('explains that video comparison is optional on Linux', () => {
    expect(getVideoCompareUnavailableMessage('linux')).toContain('optional on Linux');
  });
});
