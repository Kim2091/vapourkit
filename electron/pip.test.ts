import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('child_process', () => ({ spawn: vi.fn() }));
vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./constants', () => ({
  PATHS: {
    APP_DATA: 'C:\\vk\\data',
    VS: 'C:\\vk\\data\\vapoursynth-portable',
    PYTHON: 'C:\\vk\\data\\vapoursynth-portable\\python.exe',
    PIP_CACHE: 'C:\\vk\\data\\pip-cache',
  },
  PIP_NETWORK_ARGS: ['--retries', '5'],
}));
vi.mock('./processLifecycle', () => ({
  createWorkloadSpawnOptions: (options: object) => ({ ...options, workload: true }),
  terminateProcessTree: vi.fn((child: FakeChild) => child.die()),
}));
vi.mock('fs', () => ({
  promises: {
    mkdtemp: vi.fn(async () => 'C:\\tmp\\vkp-1'),
    symlink: vi.fn(async () => undefined),
    rmdir: vi.fn(async () => undefined),
  },
}));

import { spawn } from 'child_process';
import { promises as nodeFs } from 'fs';
import { terminateProcessTree } from './processLifecycle';
import { CommandError } from './installFlow';
import {
  canImportModules,
  createPipPathAlias,
  EnvLock,
  LineSplitter,
  pipInstall,
  pipList,
  pipUninstall,
  PipLockAbortedError,
  probePip,
  QUICK_PIP_NETWORK_ARGS,
  throwIfFailed,
  withPipLock,
} from './pip';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 1;
  out(text: string) { this.stdout.emit('data', Buffer.from(text)); }
  err(text: string) { this.stderr.emit('data', Buffer.from(text)); }
  exit(code: number | null) { this.emit('close', code); }
  die() { this.emit('close', null); }
  kill() { this.die(); }
}

/** Each spawn gets the next FakeChild; the test drives it. */
function spawns() {
  const children: FakeChild[] = [];
  vi.mocked(spawn).mockImplementation((() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  }) as never);
  return children;
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.mocked(spawn).mockReset();
  vi.mocked(terminateProcessTree).mockClear();
  vi.mocked(nodeFs.symlink).mockClear();
  vi.mocked(nodeFs.rmdir).mockClear();
});

describe('LineSplitter', () => {
  it('joins a line split across chunks and handles CRLF and bare CR', () => {
    const lines: string[] = [];
    const splitter = new LineSplitter(line => lines.push(line));
    splitter.push('Collecting tor');
    splitter.push('ch\r\nDownloading x\r');
    splitter.push('\n  \nlast');
    expect(lines).toEqual(['Collecting torch', 'Downloading x']);
    splitter.flush();
    expect(lines).toEqual(['Collecting torch', 'Downloading x', 'last']);
  });
});

describe('pipInstall', () => {
  it('builds one argument list, reports whole lines, and succeeds on exit 0', async () => {
    const children = spawns();
    const lines: string[] = [];
    const run = pipInstall(['torch'], { step: 'Installing PyTorch', extraArgs: ['--upgrade'], onLine: line => lines.push(line) });
    await flush();

    const [command, args, options] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[], { cwd: string; windowsHide: boolean; workload: boolean }];
    expect(command).toBe('C:\\vk\\data\\vapoursynth-portable\\python.exe');
    expect(args).toEqual([
      '-m', 'pip', 'install', '--no-warn-script-location', '--cache-dir', 'C:\\vk\\data\\pip-cache',
      '--retries', '5', 'torch', '--upgrade',
    ]);
    expect(options).toMatchObject({ cwd: 'C:\\vk\\data\\vapoursynth-portable', windowsHide: true, workload: true });

    children[0].out('Collecting to');
    children[0].err('WARNING: a\n');
    children[0].out('rch\n');
    children[0].exit(0);
    const outcome = await run;
    expect(outcome.ok).toBe(true);
    expect(lines).toEqual(['WARNING: a', 'Collecting torch']);
  });

  it('takes the network flags it is given instead of the defaults', async () => {
    const children = spawns();
    const run = pipInstall(['a'], { step: 'x', networkArgs: QUICK_PIP_NETWORK_ARGS });
    await flush();
    expect(vi.mocked(spawn).mock.calls[0][1]).toEqual(expect.arrayContaining(['--retries', '1', '--timeout', '15']));
    expect(vi.mocked(spawn).mock.calls[0][1]).not.toContain('5');
    children[0].exit(0);
    await run;
  });

  it('classifies a failure from both streams and throws it as a CommandError', async () => {
    const children = spawns();
    const run = pipInstall(['torch'], { step: 'Installing PyTorch' });
    await flush();
    children[0].out('Collecting torch\n');
    children[0].err('ERROR: Could not install packages due to an OSError: [Errno 28] No space left on device\n');
    children[0].exit(1);
    const outcome = await run;
    expect(outcome).toMatchObject({ ok: false, cancelled: false, exitCode: 1 });
    expect(outcome.failure?.kind).toBe('disk-full');
    expect(outcome.output).toContain('Collecting torch');
    expect(() => throwIfFailed(outcome, 'Installing PyTorch')).toThrow(CommandError);
  });

  it('reports an interpreter that will not start', async () => {
    const children = spawns();
    const run = pipInstall(['torch'], { step: 'Installing PyTorch' });
    await flush();
    children[0].emit('error', new Error('spawn C:\\vk\\python.exe ENOENT'));
    const outcome = await run;
    expect(outcome).toMatchObject({ ok: false, spawnFailed: true, output: 'spawn C:\\vk\\python.exe ENOENT' });
  });

  it('kills the process tree on abort and resolves as cancelled', async () => {
    const children = spawns();
    const controller = new AbortController();
    const run = pipInstall(['torch'], { step: 'Installing PyTorch', signal: controller.signal });
    await flush();
    controller.abort();
    const outcome = await run;
    expect(terminateProcessTree).toHaveBeenCalledWith(children[0], 'SIGTERM');
    expect(outcome).toMatchObject({ ok: false, cancelled: true });
    expect(outcome.failure).toBeUndefined();
  });

  it('never starts pip once aborted', async () => {
    spawns();
    const controller = new AbortController();
    controller.abort();
    await expect(pipInstall(['torch'], { step: 'x', signal: controller.signal })).resolves.toMatchObject({ cancelled: true });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('installs through the short prefix and uninstalls through the junction when asked', async () => {
    const children = spawns();
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const install = pipInstall(['torch'], { step: 'x', shortPrefix: true });
      await flush();
      expect(vi.mocked(spawn).mock.calls[0][0]).toBe('C:\\vk\\data\\vapoursynth-portable\\python.exe');
      expect(vi.mocked(spawn).mock.calls[0][1]).toEqual(expect.arrayContaining(['--prefix']));
      children[0].exit(0);
      await install;
      expect(nodeFs.rmdir).toHaveBeenCalledTimes(2);

      const uninstall = pipUninstall(['torch'], { step: 'y', shortPrefix: true });
      await flush();
      expect(String(vi.mocked(spawn).mock.calls[1][0])).toMatch(/vkp-1[\\/]p[\\/]python\.exe$/);
      expect(vi.mocked(spawn).mock.calls[1][1]).toEqual(['-m', 'pip', 'uninstall', '-y', 'torch']);
      children[1].exit(0);
      await uninstall;
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('uses no junction off Windows', async () => {
    const alias = await createPipPathAlias('linux');
    expect(alias.installArgs).toEqual([]);
    expect(nodeFs.symlink).not.toHaveBeenCalled();
  });
});

describe('read-only commands', () => {
  it('parses pip list, and answers null when pip fails', async () => {
    const children = spawns();
    const listed = pipList();
    await flush();
    children[0].out('[{"name": "Torch", "version": "2.1"}, ');
    children[0].out('{"name": "vsjetpack"}]');
    children[0].exit(0);
    await expect(listed).resolves.toEqual([{ name: 'Torch', version: '2.1' }, { name: 'vsjetpack', version: '' }]);

    const failed = pipList();
    await flush();
    children[1].exit(2);
    await expect(failed).resolves.toBeNull();
  });

  it('returns the import error text', async () => {
    const children = spawns();
    const check = canImportModules(['torch', 'torchgen'], 'PyTorch runtime');
    await flush();
    expect(vi.mocked(spawn).mock.calls[0][1]?.[0]).toBe('-c');
    children[0].err("ModuleNotFoundError: No module named 'torchgen'\n");
    children[0].exit(1);
    await expect(check).resolves.toEqual({ ok: false, error: "ModuleNotFoundError: No module named 'torchgen'\n" });
  });

  it('times a hung pip probe out as inconclusive', async () => {
    const children = spawns();
    const probe = probePip(5);
    await new Promise(resolve => setTimeout(resolve, 20));
    await expect(probe).resolves.toMatchObject({ spawnFailed: false, timedOut: true, exitCode: null });
    expect(terminateProcessTree).toHaveBeenCalledWith(children[0], 'SIGTERM');
  });

  it('does not wait for the lock', async () => {
    const children = spawns();
    const gate = deferred();
    const holder = withPipLock(() => gate.promise, { label: 'install' });
    const listed = pipList();
    await flush();
    expect(spawn).toHaveBeenCalledTimes(1);
    children[0].out('[]');
    children[0].exit(0);
    await expect(listed).resolves.toEqual([]);
    gate.resolve();
    await holder;
  });
});

describe('EnvLock', () => {
  it('runs one holder at a time, in arrival order', async () => {
    const lock = new EnvLock();
    const order: string[] = [];
    const first = deferred();
    const a = lock.run(async () => { order.push('a start'); await first.promise; order.push('a end'); }, { label: 'a' });
    const b = lock.run(async () => { order.push('b'); }, { label: 'b' });
    const c = lock.run(async () => { order.push('c'); }, { label: 'c' });
    await flush();
    expect(order).toEqual(['a start']);
    expect(lock.heldBy).toBe('a');
    first.resolve();
    await Promise.all([a, b, c]);
    expect(order).toEqual(['a start', 'a end', 'b', 'c']);
    expect(lock.heldBy).toBeNull();
  });

  it('lets a holder take it again, through any depth of awaits, without deadlocking', async () => {
    const lock = new EnvLock();
    const inner = async () => lock.run(async () => {
      await flush();
      return lock.run(async () => 'nested', { label: 'list' });
    }, { label: 'step' });
    await expect(lock.run(async () => { await flush(); return inner(); }, { label: 'install' })).resolves.toBe('nested');
    expect(lock.heldBy).toBeNull();
  });

  it('lets pip calls inside a held operation run without waiting', async () => {
    const children = spawns();
    const done = withPipLock(async () => {
      const install = pipInstall(['a'], { step: 'one' });
      await flush();
      children[0].exit(0);
      await install;
      const uninstall = pipUninstall(['b'], { step: 'two' });
      await flush();
      children[1].exit(0);
      return (await uninstall).ok;
    }, { label: 'plugin install' });
    await expect(done).resolves.toBe(true);
  });

  it('makes a pip call from outside wait for the holder', async () => {
    const children = spawns();
    const gate = deferred();
    const holder = withPipLock(() => gate.promise, { label: 'plugin install' });
    const outside = pipInstall(['a'], { step: 'vs-mlrt update' });
    await flush();
    expect(spawn).not.toHaveBeenCalled();
    gate.resolve();
    await holder;
    await flush();
    expect(spawn).toHaveBeenCalledTimes(1);
    children[0].exit(0);
    await expect(outside).resolves.toMatchObject({ ok: true });
  });

  it('does not pass the hold on to a task the holder left running', async () => {
    const lock = new EnvLock();
    const background = deferred();
    let detached!: Promise<string>;
    await lock.run(async () => {
      detached = (async () => {
        await background.promise;
        return lock.run(async () => 'background', { label: 'background' });
      })();
    }, { label: 'check' });

    const gate = deferred();
    const other = lock.run(() => gate.promise, { label: 'other' });
    background.resolve();
    await flush();
    // The detached task queues behind 'other' instead of slipping in.
    expect(lock.heldBy).toBe('other');
    gate.resolve();
    await other;
    await expect(detached).resolves.toBe('background');
  });

  it('gives up waiting on abort and leaves the queue intact', async () => {
    const lock = new EnvLock();
    const gate = deferred();
    const waits: string[] = [];
    const holder = lock.run(() => gate.promise, { label: 'setup' });
    const controller = new AbortController();
    const cancelled = lock.run(async () => 'ran', { label: 'install', signal: controller.signal, onWait: heldBy => waits.push(heldBy) });
    const next = lock.run(async () => 'next', { label: 'update' });
    controller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(PipLockAbortedError);
    expect(waits).toEqual(['setup']);
    gate.resolve();
    await holder;
    await expect(next).resolves.toBe('next');
  });

  it('releases on a throw', async () => {
    const lock = new EnvLock();
    await expect(lock.run(async () => { throw new Error('boom'); }, { label: 'a' })).rejects.toThrow('boom');
    await expect(lock.run(async () => 'ok', { label: 'b' })).resolves.toBe('ok');
  });

  it('turns an abort while waiting into a cancelled pip outcome', async () => {
    spawns();
    const gate = deferred();
    const holder = withPipLock(() => gate.promise, { label: 'setup' });
    const controller = new AbortController();
    const waiting = pipUninstall(['a'], { step: 'x', signal: controller.signal });
    controller.abort();
    await expect(waiting).resolves.toMatchObject({ cancelled: true });
    expect(spawn).not.toHaveBeenCalled();
    gate.resolve();
    await holder;
  });
});
