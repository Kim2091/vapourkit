import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';

const testRoot = path.join(os.tmpdir(), `vk-trtexec-shim-test-${process.pid}`);

// The factory is hoisted above testRoot's initialization, so it must compute
// the same path itself rather than closing over the const
vi.mock('electron', async () => {
  const p = await import('path');
  const o = await import('os');
  const root = p.join(o.tmpdir(), `vk-trtexec-shim-test-${process.pid}`);
  return {
    app: {
      isPackaged: false,
      getAppPath: () => root,
      getPath: () => root,
    },
  };
});

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// getBundledBasePath resolves electron with a runtime require(), which the
// module mock above can't intercept — stub the one util trtexecShim uses
vi.mock('./utils', async () => {
  const p = await import('path');
  const o = await import('os');
  const root = p.join(o.tmpdir(), `vk-trtexec-shim-test-${process.pid}`);
  return { getBundledBasePath: () => root };
});

import { ensureTrtexecShim } from './trtexecShim';
import { IS_WINDOWS, PATHS } from './constants';

const BUILDER_MARKER = '# staged by trtexecShim.test.ts\n';

beforeAll(async () => {
  // ensureTrtexecShim copies the builder out of the app bundle
  await fs.ensureDir(path.join(testRoot, 'include'));
  await fs.writeFile(path.join(testRoot, 'include', 'build_trt_engine.py'), BUILDER_MARKER);
});

afterAll(async () => {
  await fs.remove(testRoot);
});

describe('ensureTrtexecShim', () => {
  it('copies the engine builder and writes a shim that runs it', async () => {
    const shimPath = await ensureTrtexecShim();

    expect(shimPath).toBe(PATHS.TRTEXEC_SHIM);
    expect(await fs.readFile(path.join(PATHS.APP_DATA, 'build_trt_engine.py'), 'utf-8')).toBe(BUILDER_MARKER);

    const shim = await fs.readFile(shimPath, 'utf-8');
    // Paths are quoted so a data folder containing spaces still launches
    expect(shim).toContain(`"${PATHS.PYTHON}"`);
    expect(shim).toContain(`"${path.join(PATHS.APP_DATA, 'build_trt_engine.py')}"`);
    // -u keeps the [vk-build] progress lines flowing live to vspipe's stderr
    expect(shim).toContain('-u');
    // vsmlrt's arguments must reach the builder verbatim
    expect(shim).toContain(IS_WINDOWS ? '%*' : '"$@"');
  });

  it('restores the environment vsmlrt strips before spawning it', async () => {
    const shim = await fs.readFile(await ensureTrtexecShim(), 'utf-8');

    if (IS_WINDOWS) {
      // vsmlrt passes {"CUDA_MODULE_LOADING": "LAZY"} and nothing else
      expect(shim).toMatch(/set "SystemRoot=.+"/);
      expect(shim).toMatch(/set "PATH=.+System32;.+"/);
    } else {
      expect(shim.startsWith('#!/bin/sh')).toBe(true);
    }
  });

  it('is idempotent — rewriting on every launch keeps it in step with the bundle', async () => {
    const first = await fs.readFile(await ensureTrtexecShim(), 'utf-8');
    const second = await fs.readFile(await ensureTrtexecShim(), 'utf-8');

    expect(second).toBe(first);
  });
});
