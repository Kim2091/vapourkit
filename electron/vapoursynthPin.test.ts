import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vapoursynthPin imports constants.ts, which reads app paths at module scope.
vi.mock('electron', async () => {
  const p = await import('path');
  const o = await import('os');
  const root = p.join(o.tmpdir(), `vk-vspin-test-${process.pid}`);
  return {
    app: {
      isPackaged: false,
      getAppPath: () => root,
      getPath: () => root,
    },
  };
});

import { VAPOURSYNTH_PIP_SPEC, VAPOURSYNTH_VERSION } from './constants';
import {
  compareReleaseVersions,
  isNewerThanPin,
  readInstalledVapourSynthVersion,
  releaseSegments,
} from './vapoursynthPin';

describe('the pin itself', () => {
  it('is a bare == spec on the pinned version', () => {
    expect(VAPOURSYNTH_VERSION).toBe('79');
    expect(VAPOURSYNTH_PIP_SPEC).toBe('vapoursynth==79');
  });
});

describe('releaseSegments', () => {
  it('reads the numeric release, dropping every suffix', () => {
    expect(releaseSegments('79')).toEqual([79]);
    expect(releaseSegments('79.1')).toEqual([79, 1]);
    expect(releaseSegments('80.0.post1')).toEqual([80, 0]);
    expect(releaseSegments('81rc1')).toEqual([81]);
    expect(releaseSegments('v79')).toEqual([79]);
  });

  it('returns null for anything without a leading number', () => {
    expect(releaseSegments('R79')).toBeNull();
    expect(releaseSegments('')).toBeNull();
  });
});

describe('compareReleaseVersions', () => {
  it('orders releases numerically, not lexically', () => {
    // The bug a string compare would hide: '9' > '80' as text.
    expect(compareReleaseVersions('80', '9')).toBeGreaterThan(0);
    expect(compareReleaseVersions('80', '79')).toBeGreaterThan(0);
    expect(compareReleaseVersions('79', '80')).toBeLessThan(0);
    expect(compareReleaseVersions('79', '79')).toBe(0);
  });

  it('treats a missing segment as zero', () => {
    expect(compareReleaseVersions('79', '79.0')).toBe(0);
    expect(compareReleaseVersions('79.1', '79')).toBeGreaterThan(0);
  });

  it('returns null when either side is unparseable', () => {
    expect(compareReleaseVersions('R79', '79')).toBeNull();
    expect(compareReleaseVersions('79', 'unknown')).toBeNull();
  });
});

describe('isNewerThanPin', () => {
  it('flags only cores above the pin', () => {
    expect(isNewerThanPin('80')).toBe(true);
    expect(isNewerThanPin('79.1')).toBe(true);
    expect(isNewerThanPin('79')).toBe(false);
    expect(isNewerThanPin('72')).toBe(false);
  });

  it('leaves an unreadable version alone rather than reinstalling every launch', () => {
    expect(isNewerThanPin('unknown')).toBe(false);
  });
});

describe('readInstalledVapourSynthVersion', () => {
  let sitePackages: string;

  beforeEach(async () => {
    sitePackages = await fs.mkdtemp(path.join(os.tmpdir(), 'vk-vspin-'));
  });

  afterEach(async () => {
    await fs.rm(sitePackages, { recursive: true, force: true });
  });

  const dist = (name: string) => fs.mkdir(path.join(sitePackages, name), { recursive: true });

  it('reads the version out of the dist-info directory', async () => {
    await dist('vapoursynth-79.dist-info');
    expect(await readInstalledVapourSynthVersion(sitePackages)).toBe('79');
  });

  it('is not fooled by the wheels that share the prefix', async () => {
    await dist('vapoursynth_bestsource-4.1.dist-info');
    await dist('vapoursynth-mlrt-trt-16.1.dist-info');
    await dist('vapoursynth-80.dist-info');
    expect(await readInstalledVapourSynthVersion(sitePackages)).toBe('80');
  });

  it('returns null when nothing is installed', async () => {
    await dist('torch-2.13.0.dist-info');
    expect(await readInstalledVapourSynthVersion(sitePackages)).toBeNull();
  });

  it('returns null when site-packages does not exist', async () => {
    expect(await readInstalledVapourSynthVersion(path.join(sitePackages, 'nope'))).toBeNull();
  });
});
