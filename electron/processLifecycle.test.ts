import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => 'C:/vapourkit',
    getPath: () => 'C:/vapourkit',
  },
}));

vi.mock('./logger', () => ({
  logger: { debug: vi.fn() },
}));

import { createWorkloadSpawnOptions } from './processLifecycle';

describe('createWorkloadSpawnOptions', () => {
  it('creates an isolated process group on Linux', () => {
    expect(createWorkloadSpawnOptions({ cwd: '/tmp' }, 'linux')).toEqual({
      cwd: '/tmp',
      detached: true,
    });
  });

  it('keeps Windows process creation unchanged for taskkill tree handling', () => {
    expect(createWorkloadSpawnOptions({ cwd: 'C:/temp' }, 'win32')).toEqual({
      cwd: 'C:/temp',
    });
  });
});
