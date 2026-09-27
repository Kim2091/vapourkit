// electron/templateReconcile.ts
//
// Decides what an app update does to each installed filter template.
//
// An update keeps data\, so every template an install holds is whatever the
// release that seeded it shipped, perhaps edited since. Each template has a
// base: the body we last put there, recorded in the install ledger. Comparing
// three digests answers everything - installed against base says whether the
// user edited it, base against bundled says whether we changed it since:
//
//                        we did not change it     we changed it
//   untouched            nothing                  replace silently
//   edited               nothing                  ask
//
// and for a template this release no longer ships, untouched is removed
// silently and edited is asked about. The ask is the point of the ledger:
// without a base, an edit of the current body is indistinguishable from an
// edit of an old one, and every edited template would be flagged forever.
//
// Installs from before the ledger have no base. A body some release shipped
// is taken as untouched; an edited one takes the body of the release the
// install was running, which is the best answer there is.

import { RELEASE_TEMPLATE_DIGESTS, RENAMED_TEMPLATES, SHIPPED_TEMPLATE_DIGESTS } from './shippedTemplateDigests';

export interface LedgerEntry {
  /** Digest of the body we last put there, or that the user chose to keep */
  digest: string;
  /** The app version that recorded it */
  appVersion: string;
  /** An edited copy of a template we no longer ship, which the user kept */
  keptDropped?: boolean;
  /**
   * The user deleted this built-in template in the app. Only this keeps a
   * missing template missing: one that is gone without it (removed by
   * something other than the user) is put back at launch.
   */
  deletedByUser?: boolean;
}

export type TemplateAction =
  /** Absent and never recorded: copy it in */
  | { kind: 'seed'; file: string }
  /** Recorded, absent, and not deleted by the user: put it back */
  | { kind: 'restore'; file: string }
  /** Untouched and we changed it: replace */
  | { kind: 'update'; file: string }
  /** Untouched and no longer shipped: delete */
  | { kind: 'remove'; file: string }
  /** Nothing to do to the file, but the ledger needs this base */
  | { kind: 'record'; file: string; digest: string }
  /** The ledger names a template that is gone and not coming back */
  | { kind: 'forget'; file: string }
  /** Edited, and we have changed it since: the user decides */
  | { kind: 'edited-outdated'; file: string }
  /** Edited, and no longer shipped: the user decides */
  | { kind: 'edited-dropped'; file: string; replacement?: string };

export interface TemplateState {
  /** Templates this platform seeds, by digest */
  bundled: ReadonlyMap<string, string>;
  /** Every bundled template on any platform; one this platform skips is not dropped */
  shippedAnywhere: ReadonlySet<string>;
  /** What the install holds, by digest */
  installed: ReadonlyMap<string, string>;
  ledger: Readonly<Record<string, LedgerEntry>>;
  /** The app version the install ran before this one, if known */
  previousVersion?: string;
}

export interface TemplateTables {
  history: Readonly<Record<string, readonly string[]>>;
  releases: Readonly<Record<string, Readonly<Record<string, string>>>>;
  renames: Readonly<Record<string, string>>;
}

const SHIPPED_TABLES: TemplateTables = {
  history: SHIPPED_TEMPLATE_DIGESTS,
  releases: RELEASE_TEMPLATE_DIGESTS,
  renames: RENAMED_TEMPLATES,
};

/**
 * The release tag an app version was built from: a nightly carries its
 * release's version, and tags drop a trailing .0 as often as not.
 */
export function releaseForVersion(
  version: string | undefined,
  releases: TemplateTables['releases'] = RELEASE_TEMPLATE_DIGESTS,
): Readonly<Record<string, string>> | undefined {
  if (!version) return undefined;
  const release = version.split(/[-+]/)[0];
  return releases[release] ?? releases[release.replace(/\.0$/, '')];
}

function baseOf(file: string, installed: string, state: TemplateState, tables: TemplateTables): string | undefined {
  const recorded = state.ledger[file]?.digest;
  if (recorded) return recorded;
  if (tables.history[file]?.includes(installed)) return installed;
  return releaseForVersion(state.previousVersion, tables.releases)?.[file];
}

export function planTemplateReconcile(state: TemplateState, tables: TemplateTables = SHIPPED_TABLES): TemplateAction[] {
  const actions: TemplateAction[] = [];
  const files = new Set([...state.bundled.keys(), ...state.installed.keys(), ...Object.keys(state.ledger)]);

  for (const file of [...files].sort()) {
    const bundled = state.bundled.get(file);
    const installed = state.installed.get(file);
    const entry = state.ledger[file];

    if (bundled !== undefined) {
      if (installed === undefined) {
        // A template the user deleted stays deleted; one that went missing
        // any other way is put back, as every launch before the ledger did.
        if (!entry) actions.push({ kind: 'seed', file });
        else if (!entry.deletedByUser) actions.push({ kind: 'restore', file });
        continue;
      }

      if (installed === bundled) {
        if (entry?.digest !== bundled || entry.deletedByUser) actions.push({ kind: 'record', file, digest: bundled });
        continue;
      }

      const base = baseOf(file, installed, state, tables);
      // A template of the user's own that a release now ships under the same
      // name: the release they ran did not ship it, so theirs is no edit of
      // ours. Left alone, and not recorded as ours.
      const previousRelease = releaseForVersion(state.previousVersion, tables.releases);
      if (!entry && base === undefined && previousRelease && !(file in previousRelease)) continue;
      if (installed === base) {
        actions.push({ kind: 'update', file });
      } else if (base === bundled) {
        // Edited, from the body that is still current. Theirs to keep.
        if (!entry) actions.push({ kind: 'record', file, digest: base });
      } else {
        // Edited, and either we changed it since or nothing says what the
        // edit started from (a template of their own that a release now
        // ships under the same name reads like this too).
        actions.push({ kind: 'edited-outdated', file });
      }
      continue;
    }

    if (installed === undefined) {
      if (entry && !state.shippedAnywhere.has(file)) actions.push({ kind: 'forget', file });
      continue;
    }

    // Seeded on another platform's terms, or one this platform skips; the
    // Linux catalog pass owns those.
    if (state.shippedAnywhere.has(file)) continue;

    // Never ours: a template the user made.
    if (!entry && !tables.history[file]) continue;

    // Checked before the base: a kept copy is recorded as its own base, and
    // would otherwise read as untouched and be deleted.
    if (entry?.keptDropped) continue;

    const base = baseOf(file, installed, state, tables);
    if (installed === base || tables.history[file]?.includes(installed)) {
      actions.push({ kind: 'remove', file });
    } else {
      actions.push({ kind: 'edited-dropped', file, replacement: tables.renames[file] });
    }
  }

  return actions;
}

/** A decision as the post-update notice shows it. */
export interface TemplateDecision {
  file: string;
  /** The template's own name, as the filter list shows it */
  name: string;
  kind: 'edited-outdated' | 'edited-dropped';
  /** For a dropped template that was renamed: the name it ships under now */
  replacement?: string;
}

/** The actions the user has to decide on, as opposed to ones applied silently. */
export function isDecision(action: TemplateAction): action is Extract<TemplateAction, { kind: 'edited-outdated' | 'edited-dropped' }> {
  return action.kind === 'edited-outdated' || action.kind === 'edited-dropped';
}
