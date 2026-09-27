import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const p = await import('path');
  const o = await import('os');
  const root = p.join(o.tmpdir(), `vk-launchreq-test-${process.pid}`);
  return {
    app: {
      isPackaged: false,
      getAppPath: () => root,
      getPath: () => root,
    },
  };
});

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getPypiPackages } from './vendorPackages';
import { parseRequirement, readInstalledProjects, unmetRequirements } from './launchRequirements';

describe('launch requirements', () => {
  it('parses the spec shapes the package list uses', () => {
    expect(parseRequirement('vsjetpack[full,nvidia]')).toEqual({ spec: 'vsjetpack[full,nvidia]', project: 'vsjetpack' });
    expect(parseRequirement('vs_undistort>=2.3.1')).toMatchObject({ project: 'vs-undistort', minVersion: '2.3.1' });
    expect(parseRequirement('vsview[full]>=0.3')).toMatchObject({ project: 'vsview', minVersion: '0.3' });
    expect(parseRequirement('vapoursynth==79')).toMatchObject({ project: 'vapoursynth', exactVersion: '79' });
  });

  it('parses every spec getPypiPackages returns, for every vendor', () => {
    for (const vendor of ['nvidia', 'amd', 'intel', 'unknown'] as const) {
      for (const spec of getPypiPackages(vendor)) {
        expect(parseRequirement(spec).project, spec).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      }
    }
  });

  it('asks for what a 2.0.0 environment lacks: timecube, and undistort past 2.2.0', () => {
    const installed = new Map([['vsjetpack', '1.4.0'], ['vs-undistort', '2.2.0']]);
    expect(unmetRequirements(installed, ['vsjetpack[full,nvidia]', 'vapoursynth-timecube', 'vs_undistort>=2.3.1']).map(r => r.project))
      .toEqual(['vapoursynth-timecube', 'vs-undistort']);
  });

  it('is satisfied at and above a floor, and only at a pin', () => {
    const installed = new Map([['vs-undistort', '2.3.1'], ['vapoursynth', '79']]);
    expect(unmetRequirements(installed, ['vs_undistort>=2.3.1', 'vapoursynth==79'])).toEqual([]);
    installed.set('vs-undistort', '2.4.0');
    installed.set('vapoursynth', '80');
    expect(unmetRequirements(installed, ['vs_undistort>=2.3.1', 'vapoursynth==79']).map(r => r.project)).toEqual(['vapoursynth']);
  });

  it('treats a .dev floor as its release, so a dev build satisfies it', () => {
    expect(unmetRequirements(new Map([['vs-tiletools', '1.0.0.dev3']]), ['vs_tiletools>=1.0.0.dev0'])).toEqual([]);
  });

  it('leaves an unparseable version alone rather than reinstalling every launch', () => {
    expect(unmetRequirements(new Map([['vs-undistort', 'weird']]), ['vs_undistort>=2.3.1'])).toEqual([]);
  });

  it('reads projects and versions from dist-info names', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-launchreq-'));
    try {
      for (const name of ['vs_undistort-2.3.1.dist-info', 'vapoursynth_timecube-5.0.dist-info', 'vs_undistort']) {
        fs.mkdirSync(path.join(dir, name));
      }
      const installed = await readInstalledProjects(dir);
      expect(installed.get('vs-undistort')).toBe('2.3.1');
      expect(installed.get('vapoursynth-timecube')).toBe('5.0');
      expect(installed.size).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
