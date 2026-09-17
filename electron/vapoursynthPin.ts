// electron/vapoursynthPin.ts
//
// Keeps an existing install on the pinned VapourSynth core.
//
// Pinning the install command only binds machines that install from here on.
// An environment set up before the pin landed — or one pip dragged forward
// while resolving some other wheel's `vapoursynth>=` dependency — still has
// whatever pip last picked, and a core NEWER than the pin is exactly the case
// the pin exists to prevent: the plugin ABI is what changed between R72 and
// R79, and every plugin wheel and bundled filter here is verified against the
// pinned core only. So the version actually on disk is read at launch, and a
// newer one is put back to the pin.
//
// The version is read from site-packages rather than from `pip list`: this
// runs on every launch, the dist-info directory name already carries the
// version, and a directory listing costs nothing next to spawning Python.

import { promises as fs } from 'fs';
import { VAPOURSYNTH_VERSION } from './constants';
import { projectNameFromDistInfo } from './pythonEnvIntegrity';

/**
 * The numeric release segments of a PEP 440 version ("79" → [79], "79.1.post2"
 * → [79, 1]). Anything after the release — pre/post/dev markers, a local
 * `+cu130` tag — is dropped: it never makes a core newer in the sense that
 * matters here, which is "a release the filters were not checked against".
 */
export function releaseSegments(version: string): number[] | null {
  const release = version.trim().replace(/^v/i, '').match(/^\d+(?:\.\d+)*/);
  if (!release) {
    return null;
  }
  return release[0].split('.').map(segment => parseInt(segment, 10));
}

/**
 * Compares two versions by release segments: positive when `a` is newer,
 * negative when older, 0 when equal, and null when either is unparseable.
 */
export function compareReleaseVersions(a: string, b: string): number | null {
  const left = releaseSegments(a);
  const right = releaseSegments(b);
  if (!left || !right) {
    return null;
  }

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/** True when an installed core is newer than the pin and has to be put back. */
export function isNewerThanPin(installed: string, pin: string = VAPOURSYNTH_VERSION): boolean {
  const comparison = compareReleaseVersions(installed, pin);
  // An unreadable version is left alone: a reinstall loop on every launch would
  // be worse than running whatever is there.
  return comparison !== null && comparison > 0;
}

/**
 * The installed VapourSynth version, or null when site-packages holds no
 * readable `vapoursynth-<version>.dist-info`.
 */
export async function readInstalledVapourSynthVersion(sitePackages: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(sitePackages);
  } catch {
    return null;
  }

  for (const entry of entries) {
    // Exact project match: vapoursynth-bestsource and the vapoursynth-mlrt-*
    // wheels all start with the same prefix.
    if (projectNameFromDistInfo(entry) !== 'vapoursynth') {
      continue;
    }
    const version = entry.replace(/\.dist-info$/, '').slice('vapoursynth-'.length);
    return version || null;
  }

  return null;
}
