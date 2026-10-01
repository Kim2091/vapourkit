import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// legacyCleanup imports constants.ts, which reads app paths at module scope.
vi.mock('electron', async () => {
  const p = await import('path');
  const o = await import('os');
  const root = p.join(o.tmpdir(), `vk-legacy-test-${process.pid}`);
  return { app: { isPackaged: false, getAppPath: () => root, getPath: () => root, getVersion: () => '0.0.0' } };
});

import { applyPluginCompatibilityFixes } from './legacyCleanup';

describe('applyPluginCompatibilityFixes: Linux HIP conflict', () => {
  let plugins: string;

  beforeEach(async () => {
    plugins = await fs.mkdtemp(path.join(os.tmpdir(), 'vk-plugins-'));
  });

  afterEach(async () => {
    await fs.rm(plugins, { recursive: true, force: true });
  });

  const folder = (name: string) => fs.mkdir(path.join(plugins, name), { recursive: true });
  const exists = (name: string) => fs.access(path.join(plugins, name)).then(() => true, () => false);

  it('drops bm3dhip when a dfttest2 HIP build is beside it on Linux', async () => {
    await folder('bm3dhip');
    await folder('dfttest2_hip');
    await folder('dfttest2_hiprtc');
    await applyPluginCompatibilityFixes('amd', plugins, 'linux');
    expect(await exists('bm3dhip')).toBe(false);
    expect(await exists('dfttest2_hip')).toBe(true);
    expect(await exists('dfttest2_hiprtc')).toBe(true);
  });

  it('keeps bm3dhip when nothing conflicts with it', async () => {
    await folder('bm3dhip');
    await applyPluginCompatibilityFixes('amd', plugins, 'linux');
    expect(await exists('bm3dhip')).toBe(true);
  });

  it('leaves Windows alone, where DLLs do not interpose', async () => {
    await folder('bm3dhip');
    await folder('dfttest2_hip');
    await applyPluginCompatibilityFixes('amd', plugins, 'win32');
    expect(await exists('bm3dhip')).toBe(true);
  });
});
