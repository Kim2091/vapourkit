import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => 'C:/vapourkit',
    getPath: () => 'C:/vapourkit',
  },
}));

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { VsViewManager } from './vsViewManager';

describe('VsViewManager GUI environment', () => {
  it('removes AppImage and Electron loader overrides while retaining VapourSynth paths', () => {
    const environment = VsViewManager.createGuiEnvironment({
      PATH: '/app/bin:/usr/bin',
      VS_PLUGINS_PATH: '/private/plugins',
      LD_LIBRARY_PATH: '/tmp/.mount_Vapourkit/usr/lib',
      LD_PRELOAD: '/tmp/.mount_Vapourkit/usr/lib/libfoo.so',
      QT_PLUGIN_PATH: '/tmp/.mount_Vapourkit/usr/plugins',
      QT_QPA_PLATFORM_PLUGIN_PATH: '/tmp/.mount_Vapourkit/usr/plugins/platforms',
      ELECTRON_RUN_AS_NODE: '1',
    });

    expect(environment).toMatchObject({
      PATH: '/app/bin:/usr/bin',
      VS_PLUGINS_PATH: '/private/plugins',
    });
    expect(environment.LD_LIBRARY_PATH).toBeUndefined();
    expect(environment.LD_PRELOAD).toBeUndefined();
    expect(environment.QT_PLUGIN_PATH).toBeUndefined();
    expect(environment.QT_QPA_PLATFORM_PLUGIN_PATH).toBeUndefined();
    expect(environment.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });
});
