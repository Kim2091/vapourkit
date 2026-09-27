import { describe, it, expect, vi } from 'vitest';
import {
  appendBounded,
  archiveFileNames,
  CommandError,
  describeInstallFailure,
  describeVanishedFiles,
  embeddedPythonRequiredFiles,
  failureResult,
  InstallBlockedError,
  isRetryableFailure,
  judgePipProbe,
  judgePreflight,
  missingEmbeddedPythonFiles,
  runWithRetry,
  SingleFlight,
  type InstallResult,
} from './installFlow';
import type { PreflightProblem } from './installPreflight';

describe('appendBounded', () => {
  it('keeps everything under the limit', () => {
    expect(appendBounded('abc\n', 'def\n', 100)).toBe('abc\ndef\n');
  });

  it('keeps the tail, starting at a line boundary', () => {
    const kept = appendBounded('first line\nsecond line\n', 'third line\n', 20);
    expect(kept).toBe('third line\n');
    expect(kept.length).toBeLessThanOrEqual(20);
  });

  it('keeps the raw tail when there is no line boundary to cut at', () => {
    expect(appendBounded('', 'x'.repeat(50), 10)).toBe('x'.repeat(10));
  });
});

describe('describeInstallFailure', () => {
  it('uses the classified sentence of a command failure', () => {
    const error = new CommandError('ERROR: [Errno 28] No space left on device', 1, 'Installing VapourSynth');
    const failure = describeInstallFailure(error);
    expect(failure.kind).toBe('disk-full');
    expect(failure.summary).toMatch(/^Installing VapourSynth failed because the drive/);
    expect(failure.evidence).toContain('[Errno 28]');
  });

  it('passes a preflight refusal through as it is', () => {
    const failure = describeInstallFailure(new InstallBlockedError('Setup was not started. Free up space.', '[blocking] Free up space.'));
    expect(failure).toEqual({ kind: 'preflight', summary: 'Setup was not started. Free up space.', evidence: '[blocking] Free up space.' });
  });

  it('classifies a filesystem error by its message', () => {
    const failure = describeInstallFailure(new Error("EPERM: operation not permitted, open 'C:\\vk\\data\\x.dll'"), 'Setup');
    expect(failure.kind).toBe('access-denied');
    expect(failure.summary).toMatch(/^Setup failed because Windows denied access/);
  });

  it('shows an unrecognised message as it is rather than a vaguer sentence', () => {
    const message = 'Python 3.12, 3.13, or 3.14 with venv support is required on Linux';
    expect(describeInstallFailure(new Error(message))).toEqual({ kind: 'unknown', summary: message, evidence: '' });
  });
});

describe('failureResult', () => {
  it('carries the sentence, the evidence and the log', () => {
    expect(failureResult({ summary: 'It broke.', evidence: 'line' }, 'C:\\vk\\data\\logs\\main.log')).toEqual({
      success: false,
      error: 'It broke. Full log: C:\\vk\\data\\logs\\main.log',
      summary: 'It broke.',
      evidence: 'line',
      logPath: 'C:\\vk\\data\\logs\\main.log',
    });
  });
});

describe('judgePreflight', () => {
  const full: PreflightProblem = { kind: 'disk-space', severity: 'blocking', message: 'Needs 17.5 GB, 4.0 GB free.' };
  const readOnly: PreflightProblem = { kind: 'not-writable', severity: 'blocking', message: "Can't write here." };
  const longPath: PreflightProblem = { kind: 'path-length', severity: 'warning', message: 'Path is long.' };

  it('goes ahead with only warnings', () => {
    const verdict = judgePreflight([longPath]);
    expect(verdict.refusal).toBeNull();
    expect(verdict.warnings).toEqual([longPath]);
  });

  it('refuses on a blocking problem, naming every one', () => {
    const verdict = judgePreflight([full, readOnly, longPath], { action: 'The plugin install' });
    expect(verdict.refusal).toBe("The plugin install was not started. Needs 17.5 GB, 4.0 GB free. Can't write here.");
    expect(verdict.evidence.split('\n')).toHaveLength(3);
  });

  it('lets a reinstall through a disk-space shortfall, but not an unwritable folder', () => {
    expect(judgePreflight([full], { reinstall: true }).refusal).toBeNull();
    expect(judgePreflight([full], { reinstall: true }).warnings).toEqual([full]);
    expect(judgePreflight([readOnly], { reinstall: true }).refusal).not.toBeNull();
  });
});

describe('runWithRetry', () => {
  const failed: InstallResult = { success: false, summary: 'network' };

  it('announces the retry between attempts and returns only the last result', async () => {
    const events: string[] = [];
    const attempt = vi.fn(async (n: number) => {
      events.push(`attempt ${n}`);
      return n === 1 ? failed : { success: true };
    });
    const result = await runWithRetry(attempt, {
      attempts: 2,
      shouldRetry: isRetryableFailure,
      onRetry: (_result, next) => events.push(`retrying ${next}`),
    });
    expect(result).toEqual({ success: true });
    expect(events).toEqual(['attempt 1', 'retrying 2', 'attempt 2']);
  });

  it('does not retry a cancel, a refusal or a busy installer', async () => {
    for (const result of [
      { success: false, cancelled: true },
      { success: false, blocked: true },
      { success: false, alreadyRunning: true },
    ]) {
      const attempt = vi.fn(async () => result);
      await expect(runWithRetry(attempt, { attempts: 2, shouldRetry: isRetryableFailure })).resolves.toBe(result);
      expect(attempt).toHaveBeenCalledTimes(1);
    }
  });

  it('stops after the last attempt', async () => {
    const attempt = vi.fn(async () => failed);
    await expect(runWithRetry(attempt, { attempts: 2, shouldRetry: isRetryableFailure })).resolves.toBe(failed);
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});

describe('SingleFlight', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  it('joins a second request for the same thing instead of starting it again', async () => {
    const flights = new SingleFlight<'install' | 'uninstall', string>();
    const gate = deferred<string>();
    const start = vi.fn(() => gate.promise);

    const first = flights.run('install', start, () => 'busy');
    const second = flights.run('install', start, () => 'busy');
    expect(start).toHaveBeenCalledTimes(1);
    expect(flights.running).toBe('install');

    gate.resolve('done');
    await expect(first).resolves.toBe('done');
    await expect(second).resolves.toBe('done');
    expect(flights.running).toBeNull();
  });

  it('refuses something different while one runs', async () => {
    const flights = new SingleFlight<'install' | 'uninstall', string>();
    const gate = deferred<string>();
    const install = flights.run('install', () => gate.promise, () => 'busy');
    const uninstall = vi.fn(async () => 'uninstalled');

    await expect(flights.run('uninstall', uninstall, running => `busy: ${running}`)).resolves.toBe('busy: install');
    expect(uninstall).not.toHaveBeenCalled();

    gate.resolve('done');
    await install;
    await expect(flights.run('uninstall', uninstall, () => 'busy')).resolves.toBe('uninstalled');
  });

  it('frees the slot when the operation throws', async () => {
    const flights = new SingleFlight<'install', string>();
    await expect(flights.run('install', async () => { throw new Error('boom'); }, () => 'busy')).rejects.toThrow('boom');
    expect(flights.running).toBeNull();
  });
});

describe('describeVanishedFiles', () => {
  it('says nothing when nothing vanished', () => {
    expect(describeVanishedFiles([], 'C:\\plugins')).toBeNull();
  });

  it('names the files and the folder to exclude', () => {
    const warning = describeVanishedFiles(['fmtconv.dll', 'nnedi3vk.dll', 'vsncnn.dll'], 'C:\\vk\\plugins')!;
    expect(warning).toContain('3 plugin files were removed');
    expect(warning).toContain('fmtconv.dll, nnedi3vk.dll, vsncnn.dll');
    expect(warning).toContain('Add an exclusion for C:\\vk\\plugins');
  });

  it('keeps a long list short', () => {
    const files = Array.from({ length: 12 }, (_, i) => `p${i}.dll`);
    expect(describeVanishedFiles(files, 'X')).toContain('p7.dll and 4 more');
  });
});

describe('archiveFileNames', () => {
  it('lists files and skips directories', () => {
    expect(archiveFileNames([
      { name: 'fmtconv.dll', attr: 'A' },
      { name: 'sub', attr: 'D' },
      { name: 'sub\\x.dll', attr: 'A' },
    ])).toEqual(['fmtconv.dll', 'sub\\x.dll']);
  });
});

describe('embedded Python files', () => {
  it('requires the interpreter, its DLLs and the standard library', () => {
    expect(embeddedPythonRequiredFiles('3.13.0')).toEqual(['python.exe', 'python313.dll', 'python3.dll', 'python313.zip']);
  });

  it('reports an extraction interrupted after python.exe as incomplete', () => {
    const present = new Set(['python.exe']);
    expect(missingEmbeddedPythonFiles('3.13.0', file => present.has(file))).toEqual(['python313.dll', 'python3.dll', 'python313.zip']);
  });
});

describe('judgePipProbe', () => {
  it('is healthy when pip answers with its version', () => {
    expect(judgePipProbe({ spawnFailed: false, exitCode: 0, output: 'pip 26.2.1 from C:\\vk\\Lib\\site-packages\\pip (python 3.13)\n' })).toBe('healthy');
  });

  it('repairs pip when Python runs but pip is missing (vapourkit-nightly#1)', () => {
    expect(judgePipProbe({ spawnFailed: false, exitCode: 1, output: 'C:\\vk\\python.exe: No module named pip\n' })).toBe('repair-pip');
  });

  it('does not reach for get-pip when Python itself is broken', () => {
    expect(judgePipProbe({ spawnFailed: true, exitCode: null, output: 'spawn python.exe ENOENT' })).toBe('python-broken');
    expect(judgePipProbe({
      spawnFailed: false,
      exitCode: 1,
      output: "Fatal Python error: init_fs_encoding: failed to get the Python codec of the filesystem encoding\nModuleNotFoundError: No module named 'encodings'",
    })).toBe('python-broken');
  });

  it('draws no conclusion from a probe that timed out', () => {
    expect(judgePipProbe({ spawnFailed: false, timedOut: true, exitCode: null, output: '' })).toBe('inconclusive');
  });
});
