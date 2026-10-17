// electron/pip.ts
//
// Every pip run against the app's Python environment goes through here: the
// arguments every install shares, the short Windows prefix, line-buffered
// output, bounded capture, error classification, cancelling, and the one lock
// that keeps two writers out of site-packages at once.

import { spawn, type ChildProcess } from 'child_process';
import { AsyncLocalStorage } from 'async_hooks';
import { promises as nodeFs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logger } from './logger';
import { PATHS, PIP_NETWORK_ARGS } from './constants';
import { createWorkloadSpawnOptions, terminateProcessTree } from './processLifecycle';
import { appendBounded, CommandError, type PipProbe } from './installFlow';
import { classifyInstallError, type ClassifiedInstallError } from './installErrors';
import { LineSplitter } from './lineSplitter';

// ---------------------------------------------------------------------------
// The environment lock
// ---------------------------------------------------------------------------

/** Thrown by withPipLock when its signal aborts while it waits for the lock. */
export class PipLockAbortedError extends Error {
  constructor() {
    super('Cancelled while waiting for another Python package operation');
    this.name = 'PipLockAbortedError';
  }
}

interface Hold {
  label: string;
}

interface Waiter {
  hold: Hold;
  grant: () => void;
}

/**
 * A FIFO mutex over the Python environment. A holder that calls withPipLock
 * again, directly or through anything it awaits, runs straight through: the
 * hold travels with the async context, so an install that lists packages or
 * runs several pip steps never waits on itself. A task the holder starts and
 * leaves running keeps the context but not the hold, because the hold is
 * matched by identity against the current holder and ends when the holder's
 * function settles.
 *
 * A holder must not wait on work that is itself queued for the lock, such as
 * joining a SingleFlight whose operation is waiting here; that is the one way
 * to deadlock it.
 */
export class EnvLock {
  private readonly context = new AsyncLocalStorage<Hold>();
  private holder: Hold | null = null;
  private readonly waiters: Waiter[] = [];

  /** The label of the operation holding the lock, or null when it is free. */
  get heldBy(): string | null {
    return this.holder?.label ?? null;
  }

  /** Whether the calling context holds the lock. */
  get heldHere(): boolean {
    const hold = this.context.getStore();
    return hold !== undefined && hold === this.holder;
  }

  async run<T>(
    fn: () => Promise<T>,
    options: { label: string; signal?: AbortSignal; onWait?: (heldBy: string) => void },
  ): Promise<T> {
    if (this.heldHere) return fn();

    const hold: Hold = { label: options.label };
    await this.acquire(hold, options);
    try {
      return await this.context.run(hold, fn);
    } finally {
      this.release(hold);
    }
  }

  private acquire(hold: Hold, options: { signal?: AbortSignal; onWait?: (heldBy: string) => void }): Promise<void> {
    if (options.signal?.aborted) return Promise.reject(new PipLockAbortedError());
    if (!this.holder) {
      this.holder = hold;
      return Promise.resolve();
    }

    logger.info(`${hold.label} is waiting for ${this.holder.label} to finish with the Python environment`);
    options.onWait?.(this.holder.label);
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new PipLockAbortedError());
      };
      const waiter: Waiter = {
        hold,
        grant: () => {
          options.signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      this.waiters.push(waiter);
      options.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private release(hold: Hold): void {
    if (this.holder !== hold) return;
    const next = this.waiters.shift();
    this.holder = next?.hold ?? null;
    next?.grant();
  }
}

const envLock = new EnvLock();

/**
 * Runs `fn` with the Python environment to itself. Wrap a whole operation
 * (an install with all its steps, setup's runtime phase, a launch's repairs)
 * so nothing else changes the environment between its steps; the pip calls
 * inside take the lock too and pass straight through.
 */
export function withPipLock<T>(
  fn: () => Promise<T>,
  options: { label: string; signal?: AbortSignal; onWait?: (heldBy: string) => void },
): Promise<T> {
  return envLock.run(fn, options);
}

// ---------------------------------------------------------------------------
// Running a process
// ---------------------------------------------------------------------------

/** How a pip or Python run ended. */
export interface PipOutcome {
  ok: boolean;
  cancelled: boolean;
  timedOut: boolean;
  /** Null when the process could not be started, was killed, or timed out. */
  exitCode: number | null;
  /** The interpreter could not be started; `output` holds Node's error. */
  spawnFailed: boolean;
  stdout: string;
  stderr: string;
  /** stdout and stderr in arrival order, tail only. */
  output: string;
  /** Set when the run failed and was not cancelled. */
  failure?: ClassifiedInstallError;
}

export interface RunOptions {
  /** What the run is for ("Installing PyTorch"); opens the sentence shown if it fails. */
  step: string;
  /** The interpreter to start; PATHS.PYTHON when omitted. */
  python?: string;
  cwd?: string;
  /** Called with each complete line of either stream, trimmed and non-empty. */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** Aborting kills the process tree and resolves the outcome as cancelled. */
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Characters of each stream kept; the default suits pip's longest runs. */
  captureChars?: number;
  /** Logs each line at info level with a [pip] prefix. */
  logLines?: boolean;
  /** Starts the process in its own process group on POSIX, so a cancel ends its children too. */
  workload?: boolean;
}

/** Runs the interpreter with `args` and settles once it has exited; never rejects. */
export function runPython(args: string[], options: RunOptions): Promise<PipOutcome> {
  const python = options.python ?? PATHS.PYTHON;
  const captureChars = options.captureChars;
  logger.info(`Running command: ${python} ${args.join(' ')}`);

  return new Promise<PipOutcome>((resolve) => {
    let stdout = '';
    let stderr = '';
    let output = '';
    let settled = false;
    let cancelled = false;
    let timedOut = false;
    let child: ChildProcess;
    let timer: NodeJS.Timeout | undefined;

    const finish = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      outSplitter.flush();
      errSplitter.flush();
      const spawnFailed = spawnError !== undefined;
      if (spawnFailed) output = spawnError;
      const ok = !spawnFailed && !cancelled && !timedOut && exitCode === 0;
      const outcome: PipOutcome = { ok, cancelled, timedOut, exitCode, spawnFailed, stdout, stderr, output };
      if (!ok && !cancelled) {
        outcome.failure = classifyInstallError(output, { step: options.step, exitCode });
        logger.error(`${options.step}: ${spawnFailed ? `could not start ${python}` : timedOut ? 'timed out' : `exited with code ${exitCode}`}`);
        if (stderr.trim() && !spawnFailed) {
          logger.error('Error output:');
          stderr.split('\n').forEach(line => { if (line.trim()) logger.error(`  ${line}`); });
        }
        logger.error(`${options.step} failed (${outcome.failure.kind}): ${outcome.failure.summary}`);
      }
      resolve(outcome);
    };

    const kill = () => {
      if (child) terminateProcessTree(child, 'SIGTERM');
    };
    const onAbort = () => {
      cancelled = true;
      kill();
    };

    const lineHandler = (stream: 'stdout' | 'stderr') => (line: string) => {
      if (options.logLines) logger.info(`[pip] ${line}`);
      options.onLine?.(line, stream);
    };
    const outSplitter = new LineSplitter(lineHandler('stdout'));
    const errSplitter = new LineSplitter(lineHandler('stderr'));

    if (options.signal?.aborted) {
      cancelled = true;
      finish(null);
      return;
    }

    const spawnOptions = { cwd: options.cwd ?? PATHS.VS, windowsHide: true };
    try {
      child = spawn(python, args, options.workload ? createWorkloadSpawnOptions(spawnOptions) : spawnOptions);
    } catch (error) {
      finish(null, error instanceof Error ? error.message : String(error));
      return;
    }

    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        kill();
        finish(null);
      }, options.timeoutMs);
    }

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout = appendBounded(stdout, text, captureChars);
      output = appendBounded(output, text, captureChars);
      outSplitter.push(text);
    });
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr = appendBounded(stderr, text, captureChars);
      output = appendBounded(output, text, captureChars);
      errSplitter.push(text);
    });
    // Node's own words ("spawn ...python.exe ENOENT") are what the classifier
    // recognises a missing interpreter by.
    child.on('error', (error: Error) => finish(null, error.message));
    child.on('close', (code: number | null) => finish(code));
  });
}

/** Throws the outcome's failure as a CommandError, which carries the classified sentence. */
export function throwIfFailed(outcome: PipOutcome, step: string): PipOutcome {
  if (outcome.ok) return outcome;
  if (outcome.cancelled) throw new Error(`${step} was cancelled`);
  throw new CommandError(outcome.output, outcome.exitCode, step);
}

// ---------------------------------------------------------------------------
// The short Windows prefix
// ---------------------------------------------------------------------------

interface PathAlias {
  /** `--prefix <junction>` for an install, or nothing. */
  installArgs: string[];
  /** The interpreter reached through the junction, for an uninstall. */
  pythonPath: string;
  cleanup: () => Promise<void>;
}

/**
 * Gives Windows pip a short junction to the environment. Recent PyTorch
 * wheels contain deeply nested license files; the normal installed-app path
 * can push those past Windows' legacy path limit and leave a partially
 * extracted wheel behind.
 *
 * Installs launch the real python.exe and use the junction only as
 * `--prefix`, so generated command launchers keep the permanent interpreter
 * path. Uninstalls launch through the junction so pip can remove the same
 * deep files. Either way the files live in PATHS.VS.
 */
export async function createPipPathAlias(platform: NodeJS.Platform = process.platform): Promise<PathAlias> {
  const none: PathAlias = { installArgs: [], pythonPath: PATHS.PYTHON, cleanup: async () => {} };
  if (platform !== 'win32') return none;

  let tempRoot: string | null = null;
  let alias: string | null = null;
  const cleanup = async () => {
    if (alias) {
      await nodeFs.rmdir(alias).catch(error => logger.warn(`Failed to remove temporary pip junction ${alias}:`, error));
    }
    if (tempRoot) {
      await nodeFs.rmdir(tempRoot).catch(error => logger.warn(`Failed to remove temporary pip directory ${tempRoot}:`, error));
    }
  };

  try {
    tempRoot = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'vkp-'));
    alias = path.join(tempRoot, 'p');
    await nodeFs.symlink(PATHS.VS, alias, 'junction');
    logger.info(`Using short pip install prefix: ${alias} -> ${PATHS.VS}`);
    return {
      installArgs: ['--prefix', alias],
      pythonPath: path.join(alias, path.basename(PATHS.PYTHON)),
      cleanup,
    };
  } catch (error) {
    await cleanup();
    logger.warn('Failed to create a short pip install prefix; using the installed path:', error);
    return none;
  }
}

// ---------------------------------------------------------------------------
// pip commands
// ---------------------------------------------------------------------------

/** Short retries for a launch-time install that must not hold up an offline machine. */
export const QUICK_PIP_NETWORK_ARGS = ['--retries', '1', '--timeout', '15', '--progress-bar', 'off'];

export interface PipWriteOptions extends Omit<RunOptions, 'python' | 'logLines' | 'workload'> {
  /** Runs through the short Windows junction (createPipPathAlias). */
  shortPrefix?: boolean;
  /** Label of the lock this run takes when its caller does not hold it. */
  lockLabel?: string;
}

export interface PipInstallOptions extends PipWriteOptions {
  /** Flags after the package list (--upgrade, index URLs, --no-deps). */
  extraArgs?: string[];
  /** Retry and timeout flags; PIP_NETWORK_ARGS when omitted. */
  networkArgs?: string[];
}

function lockFor<T>(options: PipWriteOptions, fn: () => Promise<T>): Promise<T> {
  return withPipLock(fn, { label: options.lockLabel ?? options.step, signal: options.signal });
}

function cancelledOutcome(): PipOutcome {
  return { ok: false, cancelled: true, timedOut: false, exitCode: null, spawnFailed: false, stdout: '', stderr: '', output: '' };
}

/** The argument list of a pip install, without the junction prefix. */
export function pipInstallArgs(packages: string[], options: Pick<PipInstallOptions, 'extraArgs' | 'networkArgs'> = {}, prefixArgs: string[] = []): string[] {
  return [
    '-m', 'pip', 'install',
    '--no-warn-script-location',
    // One cache for every install, so the prune after a plugin install covers
    // them all; pip's default cache is in the user profile, out of sight.
    '--cache-dir', PATHS.PIP_CACHE,
    ...(options.networkArgs ?? PIP_NETWORK_ARGS),
    ...prefixArgs,
    ...packages,
    ...(options.extraArgs ?? []),
  ];
}

export async function pipInstall(packages: string[], options: PipInstallOptions): Promise<PipOutcome> {
  return lockFor(options, async () => {
    if (options.signal?.aborted) return cancelledOutcome();
    const alias = options.shortPrefix ? await createPipPathAlias() : null;
    try {
      return await runPython(pipInstallArgs(packages, options, alias?.installArgs), {
        ...options, logLines: true, workload: true,
      });
    } finally {
      await alias?.cleanup();
    }
  }).catch(cancelOnLockAbort);
}

export async function pipUninstall(packages: string[], options: PipWriteOptions): Promise<PipOutcome> {
  return lockFor(options, async () => {
    if (options.signal?.aborted) return cancelledOutcome();
    const alias = options.shortPrefix ? await createPipPathAlias() : null;
    try {
      return await runPython(['-m', 'pip', 'uninstall', '-y', ...packages], {
        ...options, python: alias?.pythonPath, logLines: true, workload: true,
      });
    } finally {
      await alias?.cleanup();
    }
  }).catch(cancelOnLockAbort);
}

/** get-pip.py, which installs pip into an environment that has none. */
export function runGetPip(scriptPath: string, options: { step: string }): Promise<PipOutcome> {
  return withPipLock(
    () => runPython([scriptPath, '--no-warn-script-location', ...PIP_NETWORK_ARGS], {
      step: options.step, cwd: PATHS.APP_DATA, logLines: true, workload: true,
    }),
    { label: options.step },
  );
}

function cancelOnLockAbort(error: unknown): PipOutcome {
  if (error instanceof PipLockAbortedError) return cancelledOutcome();
  throw error;
}

/**
 * The installed distributions from `pip list`, names as pip prints them, or
 * null when pip cannot say. Read-only, so it does not wait for the lock.
 */
export async function pipList(): Promise<Array<{ name: string; version: string }> | null> {
  const outcome = await runPython(['-m', 'pip', 'list', '--format=json'], {
    step: 'Listing installed packages',
    // The JSON is parsed whole, so it is kept whole; a full install lists a
    // few hundred packages.
    captureChars: 4 * 1024 * 1024,
  });
  if (!outcome.ok) {
    if (outcome.stdout.trim()) logger.error('Standard output:', outcome.stdout);
    return null;
  }
  try {
    const parsed = JSON.parse(outcome.stdout) as Array<{ name: string; version?: string }>;
    return parsed.map(pkg => ({ name: pkg.name, version: pkg.version ?? '' }));
  } catch (error) {
    logger.error('Error parsing pip list output:', error);
    logger.error('Output buffer:', outcome.stdout);
    return null;
  }
}

export interface ImportCheck {
  ok: boolean;
  /** Python's stderr when the import failed. */
  error: string;
}

/**
 * Whether modules are actually importable. `pip list` only reads dist-info
 * metadata, so it cannot see an incomplete wheel extraction (torch present
 * with its bundled torchgen package missing, say).
 */
export async function canImportModules(modules: string[], label: string): Promise<ImportCheck> {
  const code = `import importlib; [importlib.import_module(name) for name in ${JSON.stringify(modules)}]`;
  const outcome = await runPython(['-c', code], { step: `${label} import check` });
  if (outcome.ok) return { ok: true, error: '' };
  logger.warn(`${label} import check failed (exit code: ${outcome.exitCode})` +
    (outcome.stderr.trim() ? `: ${outcome.stderr.trim()}` : ''));
  return { ok: false, error: outcome.spawnFailed ? outcome.output : outcome.stderr };
}

/**
 * `python -m pip --version`: one interpreter start, about a tenth of a
 * second, and the only check that pip will actually run. The time limit is
 * generous because antivirus scanning a first start can be slow; a probe that
 * runs out of it is inconclusive, not a verdict.
 */
export async function probePip(timeoutMs = 30_000): Promise<PipProbe> {
  const outcome = await runPython(['-m', 'pip', '--version'], {
    step: 'Checking pip',
    timeoutMs,
    captureChars: 16 * 1024,
  });
  return {
    spawnFailed: outcome.spawnFailed,
    timedOut: outcome.timedOut || undefined,
    exitCode: outcome.exitCode,
    output: outcome.output,
  };
}
