// electron/installLedger.ts
//
// What this install got from us, and what the last update did to it.
//
// The ledger (installed-components.json) records the version of each thing we
// put into data\ - a digest, and the app version that put it there - so a
// later update can tell what it may replace from what the user has changed.
// Python packages need no entry: pip's dist-info already is that ledger.
//
// The update report (update-report.json) is what the post-update notice reads.
// It holds only what was done automatically. The decisions still open are
// recomputed from the ledger whenever they are asked for, so they can never
// disagree with the files on disk.

import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs-extra';
import { PATHS } from './constants';
import { logger } from './logger';
import type { LedgerEntry } from './templateReconcile';
import type { ScriptLedgerEntry } from './scriptSync';

export interface PluginLedgerEntry {
  /** sha256 of the bundled archive the files were extracted from */
  digest: string;
  appVersion: string;
  /** What the archive put into the plugins folder */
  files: string[];
}

export interface InstallLedger {
  schema: 1;
  templates: Record<string, LedgerEntry>;
  plugins: Record<string, PluginLedgerEntry>;
  /** vs-scripts, by source (scriptSources.ts) */
  scripts: Record<string, ScriptLedgerEntry>;
  /** The last launch-time package install that failed, so launch backs off */
  packageFailure?: { at: string; specs: string[] };
}

export interface UpdateReport {
  /** null when the install predates version tracking */
  fromVersion: string | null;
  toVersion: string;
  createdAt: string;
  /** The notice opens itself once; after that it waits in Settings */
  seen: boolean;
  templatesAdded: string[];
  templatesUpdated: string[];
  templatesRemoved: string[];
  packagesInstalled: string[];
  pluginsUpdated: string[];
  scriptsUpdated: string[];
  /** Scripts the user edited, left as they were; the new versions were not installed */
  scriptsKept: string[];
}

/** What one launch did, before it is merged into the report on disk. */
export type UpdateReportDraft = Pick<UpdateReport,
  'templatesAdded' | 'templatesUpdated' | 'templatesRemoved' | 'packagesInstalled' | 'pluginsUpdated'
  | 'scriptsUpdated' | 'scriptsKept'>;

export function emptyReportDraft(): UpdateReportDraft {
  return {
    templatesAdded: [], templatesUpdated: [], templatesRemoved: [], packagesInstalled: [], pluginsUpdated: [],
    scriptsUpdated: [], scriptsKept: [],
  };
}

export function isEmptyDraft(draft: UpdateReportDraft): boolean {
  return Object.values(draft).every(list => list.length === 0);
}

const ledgerPath = () => path.join(PATHS.CONFIG, 'installed-components.json');
const reportPath = () => path.join(PATHS.CONFIG, 'update-report.json');

/**
 * Written beside and renamed into place, so a crash mid-write cannot leave
 * half a file. A plain rename replaces the old file in one step; fs-extra's
 * move with overwrite deletes it first, and a read landing in that gap - the
 * notice opening as the report is marked seen - finds nothing.
 */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.ensureDir(path.dirname(file));
  // Unique per write, so two writers can never rename each other's file.
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeJson(temp, value, { spaces: 2 });
  // Windows refuses to replace a file another handle has open; a reader
  // holds it for a moment only.
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(temp, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        await fs.remove(temp).catch(() => undefined);
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 50 * attempt));
    }
  }
}

export async function readLedger(): Promise<InstallLedger> {
  try {
    const ledger = await fs.readJson(ledgerPath()) as Partial<InstallLedger>;
    return {
      schema: 1,
      templates: ledger.templates ?? {},
      plugins: ledger.plugins ?? {},
      scripts: ledger.scripts ?? {},
      ...(ledger.packageFailure ? { packageFailure: ledger.packageFailure } : {}),
    };
  } catch (error) {
    // Absent is the normal state of an install from before the ledger. An
    // unreadable one is treated the same way: every template falls back to
    // the shipped history, which only ever errs towards asking.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('Install ledger unreadable, rebuilding it:', error);
    }
    return { schema: 1, templates: {}, plugins: {}, scripts: {} };
  }
}

export async function writeLedger(ledger: InstallLedger): Promise<void> {
  await writeJsonAtomic(ledgerPath(), ledger);
}

/**
 * Records that the user deleted a template in the app. Only a template the
 * ledger already tracks (a built-in one) is marked; the mark is what keeps
 * launch from putting it back. A template of their own has no entry to mark.
 */
export async function markTemplateDeletedByUser(file: string): Promise<void> {
  const ledger = await readLedger();
  const entry = ledger.templates[file];
  if (!entry || entry.deletedByUser) return;
  ledger.templates[file] = { ...entry, deletedByUser: true };
  await writeLedger(ledger);
}

export async function readUpdateReport(): Promise<UpdateReport | null> {
  try {
    return await fs.readJson(reportPath()) as UpdateReport;
  } catch {
    return null;
  }
}

/**
 * Adds one launch's work to the report. A second update before the first
 * report was cleared extends it rather than replacing it, so nothing done
 * silently goes unmentioned.
 */
export async function mergeUpdateReport(
  draft: UpdateReportDraft,
  fromVersion: string | null,
  toVersion: string,
): Promise<void> {
  const existing = await readUpdateReport();
  const union = (a: string[] = [], b: string[]) => [...new Set([...a, ...b])].sort();
  const report: UpdateReport = {
    fromVersion: existing ? existing.fromVersion : fromVersion,
    toVersion,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    seen: existing?.toVersion === toVersion ? existing.seen : false,
    templatesAdded: union(existing?.templatesAdded, draft.templatesAdded),
    templatesUpdated: union(existing?.templatesUpdated, draft.templatesUpdated),
    templatesRemoved: union(existing?.templatesRemoved, draft.templatesRemoved),
    packagesInstalled: union(existing?.packagesInstalled, draft.packagesInstalled),
    pluginsUpdated: union(existing?.pluginsUpdated, draft.pluginsUpdated),
    scriptsUpdated: union(existing?.scriptsUpdated, draft.scriptsUpdated),
    scriptsKept: union(existing?.scriptsKept, draft.scriptsKept),
  };
  await writeJsonAtomic(reportPath(), report);
}

export async function markUpdateReportSeen(): Promise<void> {
  const report = await readUpdateReport();
  if (report && !report.seen) await writeJsonAtomic(reportPath(), { ...report, seen: true });
}

export async function clearUpdateReport(): Promise<void> {
  await fs.remove(reportPath());
}
