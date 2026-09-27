// electron/launchRequirements.ts
//
// Which of the package specs an install asks for an existing environment no
// longer satisfies.
//
// getPypiPackages only runs at setup and on Reinstall. That was enough while
// an update wiped data\ and sent everyone back through setup; now data\
// survives, so a package a release adds to that list, or a floor it raises,
// would never reach anyone who updated into it. So launch reads the same list
// and checks each spec against what is on disk - pip's dist-info directories
// are the version ledger for Python packages, and reading their names costs a
// directory listing where `pip list` costs a Python start.

import { promises as fs } from 'fs';
import { normalizePackageName } from './packageNames';
import { projectNameFromDistInfo } from './pythonEnvIntegrity';
import { compareReleaseVersions } from './vapoursynthPin';

export interface ParsedRequirement {
  spec: string;
  /** PEP 503-normalized, as projectNameFromDistInfo returns it */
  project: string;
  /** `>=` floor, when the spec has one */
  minVersion?: string;
  /** `==` pin, when the spec has one */
  exactVersion?: string;
}

/**
 * The parts of a pip spec launch acts on. Anything beyond a bare name, extras,
 * `>=` and `==` is checked for presence only: acting on an operator it does
 * not understand would mean reinstalling on every launch.
 */
export function parseRequirement(spec: string): ParsedRequirement {
  const name = spec.split(/[[<>=!~;\s]/)[0];
  const project = normalizePackageName(name);
  // The version clauses: whatever follows the name and its extras, up to a marker.
  const clauses = spec.slice(name.length).replace(/^\s*\[[^\]]*\]/, '').split(';')[0];
  const min = />=\s*([^,\s]+)/.exec(clauses);
  const exact = /==\s*([^,\s]+)/.exec(clauses);
  return {
    spec,
    project,
    ...(min ? { minVersion: min[1] } : {}),
    ...(exact ? { exactVersion: exact[1] } : {}),
  };
}

/** Every installed project in site-packages, mapped to its version. */
export async function readInstalledProjects(sitePackages: string): Promise<Map<string, string>> {
  const installed = new Map<string, string>();
  let entries: string[];
  try {
    entries = await fs.readdir(sitePackages);
  } catch {
    return installed;
  }

  for (const entry of entries) {
    const project = projectNameFromDistInfo(entry);
    if (!project) continue;
    const stem = entry.replace(/\.dist-info$/, '');
    installed.set(project, stem.slice(stem.lastIndexOf('-') + 1));
  }
  return installed;
}

/**
 * The specs an environment does not satisfy. An unparseable installed version
 * is left alone, as the core pin does, rather than reinstalled every launch.
 */
export function unmetRequirements(installed: ReadonlyMap<string, string>, specs: readonly string[]): ParsedRequirement[] {
  return specs.map(parseRequirement).filter(requirement => {
    const version = installed.get(requirement.project);
    if (version === undefined) return true;

    if (requirement.exactVersion) {
      const comparison = compareReleaseVersions(version, requirement.exactVersion);
      return comparison !== null && comparison !== 0;
    }
    if (requirement.minVersion) {
      const comparison = compareReleaseVersions(version, requirement.minVersion);
      return comparison !== null && comparison < 0;
    }
    return false;
  });
}
