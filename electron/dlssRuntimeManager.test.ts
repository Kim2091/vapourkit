import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';

vi.mock('electron', async () => {
  const p = await import('path');
  const o = await import('os');
  const root = p.join(o.tmpdir(), `vk-dlss-runtime-test-${process.pid}`);
  return {
    app: { isPackaged: false, getAppPath: () => root, getPath: () => root },
  };
});

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dependency: vi.fn() },
}));

import { validateRuntimeFile } from './dlssRuntimeManager';

/**
 * The identity tests need real NVIDIA DLLs and are therefore machine-dependent: they run when a
 * copy is present and skip otherwise, rather than failing on a checkout that has none. Point
 * VK_DLSSNR_TEST_DLL / VK_DLSS_OTHER_TEST_DLL at copies to run them from anywhere.
 */
const PLUGIN_DIR = path.join(
  process.cwd(),
  'data', 'vapoursynth-portable', 'Lib', 'site-packages', 'vapoursynth', 'plugins',
);

function locate(filename: string, override?: string): string | null {
  const candidates = [override, path.join(PLUGIN_DIR, filename)].filter(Boolean) as string[];
  return candidates.find(candidate => fs.existsSync(candidate)) ?? null;
}

describe('validateRuntimeFile', () => {
  it('rejects a file far too small to be the runtime', async () => {
    const tiny = path.join(os.tmpdir(), `vk-dlss-tiny-${process.pid}.dll`);
    await fs.writeFile(tiny, Buffer.alloc(1024));
    try {
      const result = await validateRuntimeFile(tiny);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/158 MB|different DLL|incomplete/i);
    } finally {
      await fs.remove(tiny);
    }
  });

  it('rejects a path that does not exist', async () => {
    const result = await validateRuntimeFile(path.join(os.tmpdir(), 'vk-dlss-nope.dll'));
    expect(result.valid).toBe(false);
  });

  it('accepts a real nvngx_dlssnr.dll and reports its version', async () => {
    const runtime = locate('nvngx_dlssnr.dll', process.env.VK_DLSSNR_TEST_DLL);
    if (!runtime) return;

    const result = await validateRuntimeFile(runtime);
    expect(result.valid).toBe(true);
    // NVIDIA writes the version with commas; the validator normalises it to dots.
    expect(result.version).toMatch(/^\d+(\.\d+)+$/);
  });

  it('rejects nvngx_dlss.dll, which is the same size class and exports the same NGX symbols', async () => {
    // The discriminator has to be VERSIONINFO InternalName: every NGX snippet exports the same
    // NVSDK_NGX_D3D12_* entry points, so an export-table check passes this file too.
    const other = locate('nvngx_dlss.dll', process.env.VK_DLSS_OTHER_TEST_DLL);
    if (!other) return;

    const result = await validateRuntimeFile(other);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/not the DLSS 5 Neural Uplift runtime/i);
  });
});
