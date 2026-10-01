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
  findProjectsNeedingNewerCore,
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

describe('findProjectsNeedingNewerCore', () => {
  let sitePackages: string;

  beforeEach(async () => {
    sitePackages = await fs.mkdtemp(path.join(os.tmpdir(), 'vk-vsdeps-'));
  });

  afterEach(async () => {
    await fs.rm(sitePackages, { recursive: true, force: true });
  });

  const dist = async (name: string, ...requires: string[]) => {
    const dir = path.join(sitePackages, name);
    await fs.mkdir(dir, { recursive: true });
    const headers = ['Metadata-Version: 2.4', `Name: ${name.split('-')[0]}`, ...requires.map(r => `Requires-Dist: ${r}`)];
    await fs.writeFile(path.join(dir, 'METADATA'), [...headers, '', 'Requires-Dist: vapoursynth>=99 (in the description)'].join('\r\n'));
  };

  it('finds the plugin that came out with R80', async () => {
    await dist('vapoursynth-80.dist-info');
    await dist('vapoursynth_bestsource-22.dist-info', 'VapourSynth>=80');
    await dist('vapoursynth_ffms2-5.3.0.dist-info', 'vapoursynth>=74');
    await dist('vsjetpack-2.2.0.dist-info', 'vapoursynth>=78', 'vapoursynth-bestsource>=17.0');
    expect(await findProjectsNeedingNewerCore(sitePackages, '79')).toEqual(['vapoursynth-bestsource']);
  });

  it('reads old-style parentheses, markers and strict floors', async () => {
    await dist('a_plugin-1.dist-info', 'vapoursynth (>=80)');
    await dist('b_plugin-1.dist-info', 'vapoursynth>=80; sys_platform == "win32"');
    await dist('c_plugin-1.dist-info', 'vapoursynth>79');
    await dist('d_plugin-1.dist-info', 'vapoursynth>78');
    expect((await findProjectsNeedingNewerCore(sitePackages, '79')).sort()).toEqual(['a-plugin', 'b-plugin', 'c-plugin']);
  });

  it('ignores optional requirements and look-alike names', async () => {
    await dist('e_plugin-1.dist-info', 'vapoursynth>=80; extra == "new"');
    await dist('f_plugin-1.dist-info', 'vapoursynth-bestsource>=80');
    expect(await findProjectsNeedingNewerCore(sitePackages, '79')).toEqual([]);
  });

  it('returns nothing when site-packages does not exist', async () => {
    expect(await findProjectsNeedingNewerCore(path.join(sitePackages, 'nope'))).toEqual([]);
  });
});

