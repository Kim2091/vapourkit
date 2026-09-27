// electron/installFlow.ts
//
// The decisions the dependency install makes about itself: when it may start,
// when it may retry, what it tells the user when it stops, and whether what it
// left behind is still there.
//
// They live apart from pluginInstaller.ts and dependencyManager.ts because
// those two are wired to Electron, pip and the disk, and every one of these
// rules was once wrong in a way only a user saw: a Retry button that started
// a second pip in the same environment while the first was still running, an
// error shown while the automatic retry was already under way, a setup that
// said "exit code 1" and nothing else. Kept pure so each rule has a test.

import {
  classifyInstallError,
  formatInstallError,
  type ClassifiedInstallError,
  type InstallErrorKind,
} from './installErrors';
import type { PreflightProblem } from './installPreflight';

/** What an install, uninstall or setup phase reports back to the renderer. */
export interface InstallResult {
  success: boolean;
  /** summary plus where the full log is, for places that show one string */
  error?: string;
  /** One sentence saying what went wrong and what to do */
  summary?: string;
  /** The output lines the summary was drawn from, for a collapsible details area */
  evidence?: string;
  logPath?: string;
  /** Stopped because the user cancelled it; not a failure to report */
  cancelled?: boolean;
  /** Refused because another install or uninstall was already running */
  alreadyRunning?: boolean;
  /** Refused before it started (preflight); running it again cannot help */
  blocked?: boolean;
  /** Things the user should know about an install that otherwise worked */
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Output capture
// ---------------------------------------------------------------------------

/**
 * pip's output for a full NVIDIA install runs to megabytes, and the reason it
 * failed is always at the end. Keeping the tail bounds the memory a runaway
 * install can take without losing the part the classifier reads.
 */
export const MAX_CAPTURED_OUTPUT_CHARS = 200 * 1024;

export function appendBounded(buffer: string, chunk: string, maxChars: number = MAX_CAPTURED_OUTPUT_CHARS): string {
  const combined = buffer + chunk;
  if (combined.length <= maxChars) return combined;
  // Cut at a line boundary where there is one, so the first line kept is not
  // half of something the classifier then misreads.
  const cut = combined.slice(combined.length - maxChars);
  const newline = cut.indexOf('\n');
  return newline >= 0 && newline < cut.length - 1 ? cut.slice(newline + 1) : cut;
}

// ---------------------------------------------------------------------------
// Errors that already know what to tell the user
// ---------------------------------------------------------------------------

/**
 * A command that exited non-zero. The message is the classified sentence,
 * which is what ends up in front of the user when this propagates; the raw
 * output stays on the error for the log and the details area.
 */
export class CommandError extends Error {
  readonly classified: ClassifiedInstallError;
  readonly output: string;
  readonly exitCode: number | null;

  constructor(output: string, exitCode: number | null, step?: string) {
    const classified = classifyInstallError(output, { step, exitCode });
    super(classified.summary);
    this.name = 'CommandError';
    this.classified = classified;
    this.output = output;
    this.exitCode = exitCode;
  }
}

/** An install refused before it started; its message is already the sentence to show. */
export class InstallBlockedError extends Error {
  readonly evidence: string;

  constructor(summary: string, evidence: string) {
    super(summary);
    this.name = 'InstallBlockedError';
    this.evidence = evidence;
  }
}

export interface InstallFailure {
  kind: InstallErrorKind | 'preflight';
  summary: string;
  evidence: string;
}

/**
 * What to tell the user about an error thrown somewhere in an install.
 *
 * A command failure and a preflight refusal already carry their sentence.
 * Anything else is run through the classifier on its message, which catches
 * a Node ENOSPC or EPERM thrown by fs; when the classifier recognises nothing
 * the message is shown as it is, because the errors that reach here unclassified
 * (a download that failed, "Python 3.12 or newer is required") were written
 * for the user already, and the classifier's generic "failed" would say less.
 */
export function describeInstallFailure(error: unknown, step?: string): InstallFailure {
  if (error instanceof CommandError) {
    return { ...error.classified };
  }
  if (error instanceof InstallBlockedError) {
    return { kind: 'preflight', summary: error.message, evidence: error.evidence };
  }
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  const classified = classifyInstallError(message, { step });
  if (classified.kind !== 'unknown') {
    return classified;
  }
  return { kind: 'unknown', summary: message, evidence: '' };
}

/** A failed InstallResult carrying the sentence, its evidence and where the full log is. */
export function failureResult(failure: { summary: string; evidence: string }, logPath?: string): InstallResult {
  return {
    success: false,
    // formatInstallError reads only the summary; the kind is not part of the sentence.
    error: formatInstallError({ kind: 'unknown', ...failure }, logPath),
    summary: failure.summary,
    evidence: failure.evidence || undefined,
    logPath,
  };
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export interface PreflightVerdict {
  blocking: PreflightProblem[];
  warnings: PreflightProblem[];
  /** The sentence to stop the install with, or null to go ahead */
  refusal: string | null;
  /** Every problem, one per line, for the details area */
  evidence: string;
}

/**
 * Splits preflight's findings into what stops the install and what is only
 * worth saying.
 *
 * The disk-space figures are for a fresh install. A reinstall over one that
 * already targets this GPU vendor mostly finds its packages satisfied and
 * downloads little, so refusing it for want of the fresh-install figure would
 * stop someone repairing a working install on a nearly full drive; there a
 * shortfall is only a warning, and pip reports a real one if it happens.
 */
export function judgePreflight(
  problems: PreflightProblem[],
  options: { reinstall?: boolean; action?: string } = {},
): PreflightVerdict {
  const blocking: PreflightProblem[] = [];
  const warnings: PreflightProblem[] = [];
  for (const problem of problems) {
    const downgrade = options.reinstall && problem.kind === 'disk-space';
    (problem.severity === 'blocking' && !downgrade ? blocking : warnings).push(problem);
  }
  const action = options.action ?? 'The install';
  return {
    blocking,
    warnings,
    refusal: blocking.length > 0
      ? `${action} was not started. ${blocking.map(problem => problem.message).join(' ')}`
      : null,
    evidence: problems.map(problem => `[${problem.severity}] ${problem.message}`).join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Retrying
// ---------------------------------------------------------------------------

/**
 * Runs `attempt` up to `attempts` times while `shouldRetry` says a failure is
 * worth another go. Only the final result is returned: whoever reports the
 * failure to the user does it once, after the last attempt, and `onRetry` is
 * how the ones in between are announced. Reporting the first failure as final
 * is what re-enabled the setup screen's buttons while the retry was running.
 */
export async function runWithRetry<R extends { success: boolean }>(
  attempt: (attemptNumber: number) => Promise<R>,
  options: {
    attempts: number;
    shouldRetry: (result: R) => boolean;
    onRetry?: (result: R, nextAttempt: number) => void;
  },
): Promise<R> {
  let result = await attempt(1);
  for (let next = 2; next <= options.attempts; next++) {
    if (result.success || !options.shouldRetry(result)) return result;
    options.onRetry?.(result, next);
    result = await attempt(next);
  }
  return result;
}

/** A failure a second attempt could fix: not a cancel, not a refusal, not a busy installer. */
export function isRetryableFailure(result: InstallResult): boolean {
  return !result.success && !result.cancelled && !result.blocked && !result.alreadyRunning;
}

// ---------------------------------------------------------------------------
// One operation at a time
// ---------------------------------------------------------------------------

/**
 * Lets one operation run at a time. Two pips writing the same site-packages
 * corrupt each other's RECORD files, which then blocks every later install
 * (see pythonEnvIntegrity.ts), so a second request must never start another.
 *
 * Asking again for what is already running joins it: the setup screen's Retry
 * and the automatic retry want the same outcome, and the caller gets it when
 * the running one finishes. Asking for something different while one runs is
 * refused with `busy`, since an uninstall cannot sensibly wait behind an
 * install the user may be about to cancel.
 */
export class SingleFlight<K extends string, R> {
  private current: { kind: K; promise: Promise<R> } | null = null;

  get running(): K | null {
    return this.current?.kind ?? null;
  }

  run(kind: K, start: () => Promise<R>, busy: (running: K) => R): Promise<R> {
    if (this.current) {
      return this.current.kind === kind ? this.current.promise : Promise.resolve(busy(this.current.kind));
    }
    const promise = (async () => {
      try {
        return await start();
      } finally {
        this.current = null;
      }
    })();
    this.current = { kind, promise };
    return promise;
  }
}

// ---------------------------------------------------------------------------
// Checking what was installed is still there
// ---------------------------------------------------------------------------

/**
 * The warning for files that were extracted and then disappeared.
 *
 * Nothing in Vapourkit deletes a file between extracting it and checking for
 * it, so a file that is gone was taken by antivirus: Defender quarantines
 * fmtconv.dll, nnedi3vk.dll and vsncnn.dll on some machines (issue #11). The
 * install itself carries on; the filters using those plugins will not load.
 */
export function describeVanishedFiles(missing: string[], folder: string): string | null {
  if (missing.length === 0) return null;
  const shown = missing.slice(0, 8).join(', ');
  const more = missing.length > 8 ? ` and ${missing.length - 8} more` : '';
  const noun = missing.length === 1 ? 'file was' : 'files were';
  return `${missing.length} plugin ${noun} removed right after being installed (${shown}${more}), ` +
    `most likely by antivirus. Add an exclusion for ${folder} in your antivirus (Windows Security > ` +
    `Virus & threat protection > Exclusions), restore the files from quarantine or reinstall plugins, ` +
    `and restart Vapourkit; filters that use them will not load until then.`;
}

/** Names of the files in a 7-Zip listing, skipping directories. */
export function archiveFileNames(items: Array<{ name: string; attr: string }>): string[] {
  return items.filter(item => !item.attr.includes('D')).map(item => item.name);
}

// ---------------------------------------------------------------------------
// Python and pip health
// ---------------------------------------------------------------------------

/**
 * The files an embedded Python cannot start without. python.exe alone was
 * what setup used to check, so an extraction interrupted after writing it
 * but before the DLLs or the standard library zip left an install that
 * skipped re-extraction forever and could not start Python.
 *
 * pythonXY._pth is not on the list: setup rewrites it on every run whether or
 * not it was extracted, so its absence is repaired without re-extracting.
 */
export function embeddedPythonRequiredFiles(pythonVersion: string): string[] {
  const xy = pythonVersion.split('.').slice(0, 2).join('');
  return ['python.exe', `python${xy}.dll`, 'python3.dll', `python${xy}.zip`];
}

export function missingEmbeddedPythonFiles(pythonVersion: string, present: (file: string) => boolean): string[] {
  return embeddedPythonRequiredFiles(pythonVersion).filter(file => !present(file));
}

export interface PipProbe {
  /** The interpreter could not be started at all */
  spawnFailed: boolean;
  /** Did not answer in time; antivirus scanning a first start can do that */
  timedOut?: boolean;
  exitCode: number | null;
  output: string;
}

export type PipHealth = 'healthy' | 'repair-pip' | 'python-broken' | 'inconclusive';

/**
 * What `python -m pip --version` says about the environment.
 *
 * Only a Python that started and then could not find or import pip is worth
 * re-bootstrapping pip for (vapourkit-nightly#1: "No module named pip" with
 * every file check passing). A Python that cannot start, or dies before it
 * reaches pip, needs setup's Python repair rather than get-pip, and a probe
 * that timed out says nothing either way.
 */
export function judgePipProbe(probe: PipProbe): PipHealth {
  if (probe.spawnFailed) return 'python-broken';
  if (probe.timedOut) return 'inconclusive';
  if (probe.exitCode === 0 && /^pip \d/m.test(probe.output)) return 'healthy';
  if (/Fatal Python error|init_fs_encoding|No module named '?encodings'?/i.test(probe.output)) {
    return 'python-broken';
  }
  return 'repair-pip';
}
