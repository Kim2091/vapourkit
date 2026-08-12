import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', async () => {
  const path = await import('path');
  const os = await import('os');
  const root = path.join(os.tmpdir(), `vk-utils-test-${process.pid}`);
  return {
    app: {
      isPackaged: false,
      getAppPath: () => root,
      getPath: () => root,
    },
  };
});

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('./logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { spawn } from 'child_process';
import { isCommandAvailable, runCommand } from './utils';

const mockSpawn = vi.mocked(spawn);

function createProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

describe('runCommand', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it('spawns the executable and raw arguments without a shell', async () => {
    const proc = createProcess();
    mockSpawn.mockReturnValue(proc as never);

    const completed = runCommand(
      'C:\\Program Files\\Python\\python.exe',
      ['-m', 'pip', 'install', 'package name'],
      'C:\\working directory',
    );
    proc.emit('close', 0);

    await expect(completed).resolves.toBeUndefined();
    expect(mockSpawn).toHaveBeenCalledWith(
      'C:\\Program Files\\Python\\python.exe',
      ['-m', 'pip', 'install', 'package name'],
      expect.objectContaining({ cwd: 'C:\\working directory', shell: false }),
    );
  });

  it('preserves stderr in a non-zero exit error', async () => {
    const proc = createProcess();
    mockSpawn.mockReturnValue(proc as never);

    const completed = runCommand('python3', ['-m', 'pip']);
    proc.stderr.emit('data', Buffer.from('installation failed'));
    proc.emit('close', 1);

    await expect(completed).rejects.toThrow(
      'Command failed with code 1: installation failed',
    );
  });
});

describe('isCommandAvailable', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it('uses the caller-provided probe arguments', async () => {
    const proc = createProcess();
    mockSpawn.mockReturnValue(proc as never);

    const available = isCommandAvailable('ffmpeg', ['-version']);
    proc.emit('close', 0);

    await expect(available).resolves.toBe(true);
    expect(mockSpawn).toHaveBeenCalledWith(
      'ffmpeg',
      ['-version'],
      expect.objectContaining({ shell: false, stdio: 'ignore' }),
    );
  });
});
