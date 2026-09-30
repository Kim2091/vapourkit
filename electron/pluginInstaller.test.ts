import { describe, it, expect, vi, beforeEach } from 'vitest';

// PluginInstaller drives pip, 7-Zip and the network; everything it reaches
// for is replaced here so the tests exercise only its own sequencing: when it
// retries, when it says an install failed, what runs at once, and what a
// preflight refusal stops.

vi.mock('electron', () => ({
  BrowserWindow: class {},
  app: { isPackaged: false, getAppPath: () => 'C:\\vk', getPath: () => 'C:\\vk', getVersion: () => '0.0.0' },
}));
vi.mock('child_process', () => ({ spawn: vi.fn() }));
vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), getLogPath: () => 'C:\\vk\\data\\logs\\main.log' },
}));
vi.mock('./constants', () => ({
  PATHS: {
    APP_DATA: 'C:\\vk\\data',
    VS: 'C:\\vk\\data\\vapoursynth-portable',
    PYTHON: 'C:\\vk\\data\\vapoursynth-portable\\python.exe',
    SITE_PACKAGES: 'C:\\vk\\data\\vapoursynth-portable\\Lib\\site-packages',
    PLUGINS: 'C:\\vk\\data\\vapoursynth-portable\\Lib\\site-packages\\vapoursynth\\plugins',
    PIP_CACHE: 'C:\\vk\\data\\pip-cache',
    FILTER_TEMPLATES: 'C:\\vk\\data\\config\\filter-templates',
  },
  PIP_NETWORK_ARGS: [],
  PYPI_EXTRA_INDEX_ARGS: [],
}));
vi.mock('./configManager', () => ({
  configManager: {
    setGpuVendor: vi.fn(async () => undefined),
    getGpuVendor: vi.fn(() => 'nvidia'),
    getPluginsGpuVendor: vi.fn(() => undefined),
    setPluginsGpuVendor: vi.fn(async () => undefined),
    load: vi.fn(async () => undefined),
  },
}));
vi.mock('./utils', () => ({ getBundledBasePath: () => 'C:\\vk' }));
vi.mock('./processLifecycle', () => ({
  createWorkloadSpawnOptions: (options: unknown) => options,
  terminateProcessTree: vi.fn(),
}));
vi.mock('./bundledPluginArchives', () => ({ shouldExtractBundledPluginArchives: () => false }));
vi.mock('./pluginFilterCatalog', () => ({ hasPluginFilterTemplates: () => false, selectPluginFilterTemplates: (files: string[]) => files }));
vi.mock('./legacyCleanup', () => ({
  removeSupersededPlugins: vi.fn(),
  removeSupersededScripts: vi.fn(),
  applyPluginCompatibilityFixes: vi.fn(),
}));
vi.mock('./vsMlrtModelsManager', () => ({ VsMlrtModelsManager: { needsDownload: vi.fn(async () => false), ensureModels: vi.fn() } }));
vi.mock('./migxRuntimeManager', () => ({
  MigxRuntimeManager: { needsInstall: vi.fn(async () => false), ensureRuntime: vi.fn(), remove: vi.fn(async () => undefined) },
}));
vi.mock('./trtexecShim', () => ({ ensureTrtexecShim: vi.fn() }));
vi.mock('./scriptSync', () => ({ syncInstalledScripts: vi.fn(async () => ({ updated: [], removed: [], keptEdited: [], failed: [] })) }));
vi.mock('./gpuDetection', () => ({ detectGpuVendor: vi.fn(async () => 'nvidia') }));
vi.mock('./pythonEnvIntegrity', () => ({
  brokenProjectNames: vi.fn(() => []),
  inspectPythonEnvironment: vi.fn(),
  repairPythonEnvironment: vi.fn(),
}));
vi.mock('./vendorPackages', () => ({
  computeVendorPurge: vi.fn(() => []),
  evaluateInstallState: vi.fn(),
  getBackendPipPackages: vi.fn(() => []),
  getCheckPackageNames: vi.fn(() => []),
  getPypiPackages: vi.fn(() => []),
  getTorchInstall: vi.fn(() => ({ packages: ['torch'], extraArgs: [] })),
  normalizePackageName: (name: string) => name,
  UNINSTALL_PACKAGE_NAMES: ['torch'],
}));
vi.mock('7zip-min', () => ({ cmd: vi.fn(), unpack: vi.fn(), list: vi.fn() }));
vi.mock('./installPreflight', () => ({
  PLUGIN_INSTALL_REQUIRED_BYTES: { nvidia: 1, amd: 1, intel: 1, unknown: 1 },
  PLUGIN_INSTALL_REQUIRED_TEMP_BYTES: { nvidia: 1, amd: 1, intel: 1, unknown: 1 },
  runInstallPreflight: vi.fn(async () => []),
  prunePipCache: vi.fn(async () => 0),
}));

import { spawn } from 'child_process';
import { PluginInstaller, describeTorchImportFailure } from './pluginInstaller';
import { runInstallPreflight } from './installPreflight';
import { inspectPythonEnvironment } from './pythonEnvIntegrity';
import type { InstallResult } from './installFlow';

type Sent = { channel: string; payload: { type: string; message: string; summary?: string; component?: string } };

function createInstaller() {
  const sent: Sent[] = [];
  const window = { webContents: { send: (channel: string, payload: Sent['payload']) => sent.push({ channel, payload }) } };
  const installer = new PluginInstaller(window as never);
  return { installer, sent, errors: () => sent.filter(event => event.payload.type === 'error') };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

/** Replaces one attempt of the install with results the test hands out in turn. */
function scriptAttempts(installer: PluginInstaller) {
  const pending: Array<ReturnType<typeof deferred<InstallResult>>> = [];
  const spy = vi.spyOn(installer as unknown as { runInstallAttempt: () => Promise<InstallResult> }, 'runInstallAttempt')
    .mockImplementation(() => {
      const next = deferred<InstallResult>();
      pending.push(next);
      return next.promise;
    });
  return { spy, pending };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const failure: InstallResult = { success: false, summary: 'Installing PyTorch failed because it could not reach the package server.', error: 'x' };

beforeEach(() => {
  vi.mocked(spawn).mockReset();
  vi.mocked(runInstallPreflight).mockReset().mockResolvedValue([]);
  vi.mocked(inspectPythonEnvironment).mockReset();
});

describe('setup-mode install', () => {
  it('reports failure only after the automatic retry has failed too', async () => {
    const { installer, sent, errors } = createInstaller();
    const { spy, pending } = scriptAttempts(installer);

    const result = installer.installDependenciesForSetup();
    await flush();
    pending[0].resolve(failure);
    await flush();

    // Attempt 2 is running: the renderer has been told it is retrying, and
    // nothing has told it the install failed.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(errors()).toHaveLength(0);
    const retrying = sent.find(event => event.payload.type === 'retrying');
    expect(retrying?.channel).toBe('setup-progress');
    expect(retrying?.payload.component).toBe('Plugins');
    expect(retrying?.payload.message).toContain('attempt 2 of 2');

    pending[1].resolve(failure);
    await expect(result).resolves.toMatchObject({ success: false, summary: failure.summary });
    expect(errors()).toHaveLength(1);
    expect(errors()[0]).toMatchObject({ channel: 'setup-progress', payload: { component: 'Plugins', summary: failure.summary } });
  });

  it('joins a Retry pressed while it runs instead of starting a second install', async () => {
    const { installer } = createInstaller();
    const { spy, pending } = scriptAttempts(installer);

    const first = installer.installDependenciesForSetup();
    await flush();
    const second = installer.installDependenciesForSetup();
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);

    pending[0].resolve({ success: true });
    await expect(first).resolves.toEqual({ success: true });
    await expect(second).resolves.toEqual({ success: true });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('refuses an uninstall while an install runs, without starting pip', async () => {
    const { installer } = createInstaller();
    const { pending } = scriptAttempts(installer);

    const install = installer.installDependencies();
    await flush();
    await expect(installer.uninstallDependencies()).resolves.toMatchObject({ success: false, alreadyRunning: true });
    expect(spawn).not.toHaveBeenCalled();

    pending[0].resolve({ success: true });
    await install;
  });

  it('neither retries nor reports a cancelled install', async () => {
    const { installer, errors } = createInstaller();
    const { spy, pending } = scriptAttempts(installer);

    const result = installer.installDependenciesForSetup();
    await flush();
    installer.cancel();
    // The running step sees the flag (or its aborted download) and stops.
    expect((installer as unknown as { abortController: AbortController }).abortController.signal.aborted).toBe(true);
    pending[0].resolve({ success: false, cancelled: true, error: 'Installation cancelled by user' });

    await expect(result).resolves.toMatchObject({ cancelled: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(errors()).toHaveLength(0);
  });
});

describe('preflight', () => {
  it('stops the install before any pip runs, and setup does not retry it', async () => {
    vi.mocked(runInstallPreflight).mockResolvedValue([
      { kind: 'disk-space', severity: 'blocking', message: 'This install needs about 22.5 GB free on C:, but only 4.0 GB is free.' },
    ]);
    const { installer, errors } = createInstaller();

    const result = await installer.installDependenciesForSetup();

    expect(result).toMatchObject({ success: false, blocked: true });
    expect(result.summary).toBe('The plugin install was not started. This install needs about 22.5 GB free on C:, but only 4.0 GB is free.');
    expect(runInstallPreflight).toHaveBeenCalledTimes(1);
    expect(inspectPythonEnvironment).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(errors()).toHaveLength(1);
  });

  it('shows a warning and carries on', async () => {
    vi.mocked(runInstallPreflight).mockResolvedValue([
      { kind: 'path-length', severity: 'warning', message: 'The data folder path is long.' },
    ]);
    // Stop the install at its first step after preflight.
    vi.mocked(inspectPythonEnvironment).mockRejectedValue(new Error('stop here'));
    const { installer, sent } = createInstaller();

    const result = await installer.installDependencies();

    expect(sent).toContainEqual({
      channel: 'plugin-dependency-progress',
      payload: expect.objectContaining({ type: 'warning', message: 'The data folder path is long.' }),
    });
    expect(inspectPythonEnvironment).toHaveBeenCalledTimes(1);
    expect(result.warnings).toEqual(['The data folder path is long.']);
  });
});

describe('reinstall modes', () => {
  it('runs a partial reinstall unless a complete one is asked for', async () => {
    const { installer } = createInstaller();
    const spy = vi.spyOn(installer as unknown as { runInstallAttempt: (mode: string) => Promise<InstallResult> }, 'runInstallAttempt')
      .mockResolvedValue({ success: true });

    await installer.installDependencies();
    await installer.installDependencies('complete');

    expect(spy.mock.calls.map(call => call[0])).toEqual(['partial', 'complete']);
  });
});

describe('describeTorchImportFailure', () => {
  const traceback = (last: string) => [
    'Traceback (most recent call last):',
    '  File "<string>", line 1, in <module>',
    '  File "...\site-packages\torch\__init__.py", line 281, in <module>',
    last,
    '',
  ].join('\r\n');

  it('points a DLL load failure at the Visual C++ runtime and shows the error', () => {
    const last = 'OSError: [WinError 1114] A dynamic link library (DLL) initialization routine failed. ' +
      'Error loading "C:\vk\torch\lib\c10.dll" or one of its dependencies.';
    const result = describeTorchImportFailure(traceback(last));
    expect(result.summary).toContain('Visual C++');
    expect(result.evidence).toBe(last);
  });

  it('blames antivirus when a module is missing', () => {
    const result = describeTorchImportFailure(traceback("ModuleNotFoundError: No module named 'torchgen'"));
    expect(result.summary).toContain('antivirus removed them');
    expect(result.evidence).toBe("ModuleNotFoundError: No module named 'torchgen'");
  });

  it('falls back to the raw error without guessing a cause', () => {
    const result = describeTorchImportFailure(traceback('RuntimeError: something else'));
    expect(result.summary).not.toMatch(/antivirus|Visual C\+\+/);
    expect(result.evidence).toBe('RuntimeError: something else');
    expect(describeTorchImportFailure('').evidence).toMatch(/no error output/);
  });
});
