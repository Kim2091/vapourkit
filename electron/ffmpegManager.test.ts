import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => 'C:/vapourkit',
    getPath: () => 'C:/vapourkit',
  },
}));

vi.mock('./logger', () => ({
  logger: { dependency: vi.fn(), error: vi.fn() },
}));

import { FFmpegManager } from './ffmpegManager';

describe('Linux FFmpeg prerequisite guidance', () => {
  it('explains that FFmpeg is host-managed and gives actionable install examples', () => {
    const message = FFmpegManager.getHostPrerequisiteMessage();
    expect(message).toContain('FFmpeg and ffprobe are required on Linux');
    expect(message).toContain('apt install ffmpeg');
    expect(message).toContain('dnf install ffmpeg');
    expect(message).toContain('pacman -S ffmpeg');
  });
});
