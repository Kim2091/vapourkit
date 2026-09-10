// electron/pythonEnvIntegrity.ts
//
// Structural health of the portable Python environment, read straight from
// site-packages rather than from pip.
//
// `pip list` reports what the *metadata* claims, so it is blind to every way an
// install can be left half-finished. A killed install (app closed, machine
// slept, antivirus quarantine mid-unpack) is the common one: a wheel's files
// are unpacked before its RECORD is written, so an interrupted install leaves a
// dist-info that pip can neither trust nor uninstall. From then on every later
// install aborts with `uninstall-no-record-file` — not just for that package
// but for the whole pip invocation, which is how one interrupted torch install
// blocks the entire plugin install.
//
// The checks here are file-existence only: no Python process is spawned, so
// this is cheap enough to run on a status check as well as before an install.

import { promises as fs } from 'fs';
import * as path from 'path';
import { normalizePackageName } from './packageNames';

export type DistProblemKind =
  // No METADATA: pip cannot read a version, and reports the package as `None`.
  | 'no-metadata'
  // No RECORD: pip has no file list, so it aborts rather than replace the package.
  | 'no-record'
  // Metadata is intact but installed files the RECORD promises are gone.
  | 'missing-payload';

export interface DistProblem {
  /** dist-info directory name, e.g. `torch-2.13.0+cu130.dist-info`. */
  directory: string;
  /** PEP 503 project name, comparable with `pip list` output. */
  project: string;
  kind: DistProblemKind;
  /** Human-readable cause, for the log. */
  detail: string;
}

export interface EnvIntegrityReport {
  problems: DistProblem[];
  /**
   * `~`-prefixed directories, the rubble of an interrupted pip uninstall: pip
   * renames a package out of the way before deleting it, so a killed process
   * leaves `~orch` beside `torch`. They are dead weight (gigabytes, for torch)
   * and Python will import from them if a name ever collides.
   */
  staleDirectories: string[];
}

/** Distributions that have to be reinstalled before the environment is sound. */
export function brokenProjectNames(report: EnvIntegrityReport): string[] {
  return [...new Set(report.problems.map(problem => problem.project))].sort();
}

/**
 * Reads the project name out of `torch-2.13.0+cu130.dist-info`. Wheel metadata
 * directories are `{name}-{version}.dist-info`, and an escaped name may itself
 * contain dashes, so the split is on the LAST dash.
 */
export function projectNameFromDistInfo(directory: string): string | null {
  const stem = directory.replace(/\.dist-info$/, '');
  if (stem === directory) {
    return null;
  }

  const separator = stem.lastIndexOf('-');
  if (separator <= 0) {
    return null;
  }

  return normalizePackageName(stem.slice(0, separator));
}

/**
 * The paths a RECORD promises, reduced to the top-level names inside
 * site-packages. Entries reaching outside it (`../../Scripts/vspipe.exe`) and
 * the distribution's own metadata are dropped: the first is not ours to verify,
 * the second is the file being read.
 */
export function payloadNamesFromRecord(record: string): string[] {
  const names = new Set<string>();

  for (const line of record.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    // RECORD is CSV: `path,sha256=...,size`. Only a path containing a comma is
    // quoted, which is worth handling but not worth a full CSV parser.
    const rawPath = line.startsWith('"')
      ? line.slice(1, line.indexOf('"', 1))
      : line.slice(0, line.indexOf(','));
    if (!rawPath) {
      continue;
    }

    const head = rawPath.split('/')[0];
    if (
      !head ||
      head === '.' ||
      head === '..' ||
      head === '__pycache__' ||
      head.endsWith('.dist-info') ||
      head.endsWith('.egg-info') ||
      head.endsWith('.data')
    ) {
      continue;
    }

    names.add(head);
  }

  return [...names];
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function inspectDistInfo(
  sitePackages: string,
  directory: string
): Promise<DistProblem | null> {
  const project = projectNameFromDistInfo(directory);
  if (!project) {
    return null;
  }

  const distInfo = path.join(sitePackages, directory);
  const problem = (kind: DistProblemKind, detail: string): DistProblem =>
    ({ directory, project, kind, detail });

  if (!await exists(path.join(distInfo, 'METADATA'))) {
    return problem('no-metadata', 'the dist-info has no METADATA file');
  }

  let record: string;
  try {
    record = await fs.readFile(path.join(distInfo, 'RECORD'), 'utf8');
  } catch {
    return problem('no-record', 'the dist-info has no RECORD file');
  }

  // A distribution shipping only scripts or data files has nothing inside
  // site-packages to verify; an empty name list is not evidence of damage.
  const missing: string[] = [];
  for (const name of payloadNamesFromRecord(record)) {
    if (!await exists(path.join(sitePackages, name))) {
      missing.push(name);
    }
  }

  if (missing.length > 0) {
    return problem('missing-payload', `installed files are missing: ${missing.sort().join(', ')}`);
  }

  return null;
}

/**
 * Scans every dist-info in site-packages. Resolves to an empty report when the
 * directory cannot be read at all — a missing environment is the caller's
 * "nothing is installed" case, not a corruption to repair.
 */
export async function inspectPythonEnvironment(sitePackages: string): Promise<EnvIntegrityReport> {
  let entries;
  try {
    entries = await fs.readdir(sitePackages, { withFileTypes: true });
  } catch {
    return { problems: [], staleDirectories: [] };
  }

  const directories = entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
  const problems = await Promise.all(
    directories
      .filter(name => name.endsWith('.dist-info'))
      .map(name => inspectDistInfo(sitePackages, name))
  );

  return {
    problems: problems.filter((problem): problem is DistProblem => problem !== null),
    staleDirectories: directories.filter(name => name.startsWith('~')),
  };
}

export interface RepairResult {
  /** dist-info and `~` directories actually deleted. */
  removed: string[];
  /** Directories that could not be deleted, with the reason why. */
  failed: { directory: string; error: string }[];
}

/**
 * Clears the wreckage so pip can install over it.
 *
 * Deleting a dist-info makes pip treat the package as absent: it stops trying
 * to uninstall what it cannot enumerate, and stops answering "requirement
 * already satisfied" for a package whose files are gone. Both are
 * preconditions for a reinstall to repair anything. Files still on disk are
 * simply overwritten — the approach the torch repair path already takes, and
 * safer than an uninstall, whose long paths can themselves fail on Windows.
 */
export async function repairPythonEnvironment(
  sitePackages: string,
  report: EnvIntegrityReport
): Promise<RepairResult> {
  const targets = [
    ...report.problems.map(problem => problem.directory),
    ...report.staleDirectories,
  ];

  const removed: string[] = [];
  const failed: RepairResult['failed'] = [];

  for (const directory of targets) {
    try {
      await fs.rm(path.join(sitePackages, directory), { recursive: true, force: true });
      removed.push(directory);
    } catch (error) {
      failed.push({ directory, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { removed, failed };
}
