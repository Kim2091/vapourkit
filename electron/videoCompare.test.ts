import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs-extra', () => ({
  existsSync: vi.fn(),
}));

vi.mock('./utils', () => ({
  resolveHostCommand: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { EventEmitter } from 'events';
import * as fs from 'fs-extra';
import { spawn } from 'child_process';
import { resolveHostCommand } from './utils';
import {
  getVideoCompareUnavailableMessage,
  isVideoCompareAvailable,
  launchVideoCompare,
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


describe('launching video-compare', () => {
  function stubChild() {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    vi.mocked(spawn).mockReturnValue(child as never);
    return child;
  }

  beforeEach(() => {
    vi.mocked(spawn).mockReset();
  });

  it('does not hide the window, which would leave SDL decoding with nothing on screen', async () => {
    const child = stubChild();

    const launched = launchVideoCompare('video-compare', ['-W', 'a.mp4', 'b.mp4']);
    child.emit('spawn');
    await launched;

    const options = vi.mocked(spawn).mock.calls[0][2] as Record<string, unknown>;
    expect(options.windowsHide).toBeUndefined();
    expect(options.detached).toBe(true);
  });

  it('detaches the child so closing Vapourkit leaves the comparison open', async () => {
    const child = stubChild();

    const launched = launchVideoCompare('video-compare', ['a.mp4', 'b.mp4']);
    child.emit('spawn');
    await launched;

    expect(child.unref).toHaveBeenCalled();
  });

  it('surfaces a spawn failure rather than reporting success', async () => {
    const child = stubChild();

    const launched = launchVideoCompare('video-compare', ['a.mp4', 'b.mp4']);
    child.emit('error', new Error('spawn video-compare ENOENT'));

    await expect(launched).rejects.toThrow('ENOENT');
  });
});
