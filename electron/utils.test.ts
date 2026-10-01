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

vi.mock('fs', async () => ({
  ...(await vi.importActual<typeof import('fs')>('fs')),
  statSync: vi.fn(),
  accessSync: vi.fn(),
}));

vi.mock('./logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { spawn, spawnSync } from 'child_process';
import { accessSync, statSync } from 'fs';
import {
  isCommandAvailable,
  getPythonVersion,
  resolveHostCommand,
  resolveSupportedPythonCommand,
  runCommand,
  CommandError,
} from './utils';

const mockSpawn = vi.mocked(spawn);
const mockSpawnSync = vi.mocked(spawnSync);
const mockStatSync = vi.mocked(statSync);
const mockAccessSync = vi.mocked(accessSync);

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
    proc.stdout.emit('data', Buffer.from('done'));
    proc.emit('close', 0);

    await expect(completed).resolves.toEqual({ stdout: 'done', stderr: '', code: 0 });
    expect(mockSpawn).toHaveBeenCalledWith(
      'C:\\Program Files\\Python\\python.exe',
      ['-m', 'pip', 'install', 'package name'],
      expect.objectContaining({ cwd: 'C:\\working directory', shell: false }),
    );
  });

  it('keeps the raw output on the error and makes the message the classified sentence', async () => {
    const proc = createProcess();
    mockSpawn.mockReturnValue(proc as never);

    const completed = runCommand('python3', ['-m', 'pip'], undefined, undefined, { step: 'Installing VapourSynth' });
    proc.stdout.emit('data', Buffer.from('Collecting vapoursynth\n'));
    proc.stderr.emit('data', Buffer.from('ERROR: Could not install packages due to an OSError: [Errno 28] No space left on device\n'));
    proc.emit('close', 1);

    const error = await completed.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CommandError);
    const commandError = error as CommandError;
    expect(commandError.message).toMatch(/^Installing VapourSynth failed because the drive .* is full/);
    expect(commandError.classified.kind).toBe('disk-full');
    expect(commandError.exitCode).toBe(1);
    expect(commandError.output).toContain('Collecting vapoursynth');
    expect(commandError.output).toContain('[Errno 28]');
  });

  it('falls back to the exit code when the output says nothing recognisable', async () => {
    const proc = createProcess();
    mockSpawn.mockReturnValue(proc as never);

    const completed = runCommand('python3', ['-m', 'pip']);
    proc.stderr.emit('data', Buffer.from('installation failed'));
    proc.emit('close', 1);

    const error = (await completed.catch((caught: unknown) => caught)) as CommandError;
    expect(error.message).toBe('The install failed (exit code 1). The details below and the full log show why.');
    expect(error.output).toBe('installation failed');
  });

  it('classifies a missing interpreter from the spawn error', async () => {
    const proc = createProcess();
    mockSpawn.mockReturnValue(proc as never);

    const python = 'C:\\vk\\data\\vapoursynth-portable\\python.exe';
    const completed = runCommand(python, ['-m', 'pip'], undefined, undefined, { step: 'Installing pip' });
    proc.emit('error', new Error(`spawn ${python} ENOENT`));

    const error = (await completed.catch((caught: unknown) => caught)) as CommandError;
    expect(error.classified.kind).toBe('python-missing');
    expect(error.message).toMatch(/^Installing pip failed because Vapourkit's Python could not be found/);
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

describe('resolveHostCommand', () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
    mockStatSync.mockImplementation(() => ({ isFile: () => true } as never));
    mockAccessSync.mockImplementation(() => undefined);
  });

  it('uses whereis for Linux command discovery', () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: 'ffmpeg: /usr/bin/ffmpeg\n',
      stderr: '',
    } as never);

    expect(resolveHostCommand('ffmpeg', { PATH: '/usr/bin' }, 'linux')).toBe('/usr/bin/ffmpeg');
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'whereis',
      ['-b', 'ffmpeg'],
      expect.objectContaining({ env: { PATH: '/usr/bin' }, encoding: 'utf8' }),
    );
  });

  it('returns null when whereis cannot find a Linux command', () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: 'missing-command:\n',
      stderr: '',
    } as never);

    expect(resolveHostCommand('missing-command', {}, 'linux')).toBeNull();
  });

  it('falls back to the supplied PATH when whereis is unavailable', () => {
    mockSpawnSync.mockReturnValue({
      status: null,
      stdout: '',
      stderr: '',
      error: new Error('whereis not found'),
    } as never);

    expect(resolveHostCommand('python3', { PATH: '/nix/profile/bin:/usr/bin' }, 'linux')).toBe('/nix/profile/bin/python3');
  });
});

describe('Python host resolution', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockSpawnSync.mockReset();
    mockStatSync.mockImplementation(() => ({ isFile: () => true } as never));
    mockAccessSync.mockImplementation(() => undefined);
  });

  it('uses the resolved absolute interpreter for Python version detection', async () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: 'python3: /usr/bin/python3\n',
      stderr: '',
    } as never);
    const proc = createProcess();
    mockSpawn.mockReturnValue(proc as never);

    const resolution = resolveSupportedPythonCommand(['python3'], { PATH: '/usr/bin' }, 'linux');
    proc.stdout.emit('data', Buffer.from('3.14\n'));
    proc.emit('close', 0);

    await expect(resolution).resolves.toMatchObject({
      command: '/usr/bin/python3',
      version: '3.14',
    });
    expect(mockSpawn).toHaveBeenCalledWith(
      '/usr/bin/python3',
      ['-c', expect.stringContaining('sys.version_info')],
      expect.objectContaining({ shell: false }),
    );
  });

  it('reports an installed but unsupported Python instead of treating it as missing', async () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: 'python3: /usr/bin/python3\n',
      stderr: '',
    } as never);
    const proc = createProcess();
    mockSpawn.mockReturnValue(proc as never);

    const resolution = resolveSupportedPythonCommand(['python3'], { PATH: '/usr/bin' }, 'linux');
    proc.stdout.emit('data', Buffer.from('3.15\n'));
    proc.emit('close', 0);

    await expect(resolution).resolves.toMatchObject({
      command: null,
      candidates: [{ command: '/usr/bin/python3', version: '3.15' }],
    });
  });

  it('returns the Python version from a successful probe', async () => {
    const proc = createProcess();
    mockSpawn.mockReturnValue(proc as never);

    const version = getPythonVersion('/usr/bin/python3');
    proc.stdout.emit('data', Buffer.from('3.14\n'));
    proc.emit('close', 0);

    await expect(version).resolves.toBe('3.14');
  });
});
