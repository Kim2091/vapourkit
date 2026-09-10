import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  brokenProjectNames,
  inspectPythonEnvironment,
  payloadNamesFromRecord,
  projectNameFromDistInfo,
  repairPythonEnvironment,
} from './pythonEnvIntegrity';

describe('projectNameFromDistInfo', () => {
  it('reads the project name back out of a dist-info directory', () => {
    expect(projectNameFromDistInfo('torch-2.13.0+cu130.dist-info')).toBe('torch');
    expect(projectNameFromDistInfo('typing_extensions-4.16.0.dist-info')).toBe('typing-extensions');
    expect(projectNameFromDistInfo('vs_temporalfix-1.2.3.dist-info')).toBe('vs-temporalfix');
    // Only the version is split off; dashes inside the name survive.
    expect(projectNameFromDistInfo('vapoursynth-mlrt-trt-2.0.dist-info')).toBe('vapoursynth-mlrt-trt');
  });

  it('ignores directories that are not wheel metadata', () => {
    expect(projectNameFromDistInfo('torch')).toBeNull();
    expect(projectNameFromDistInfo('torch.egg-info')).toBeNull();
    expect(projectNameFromDistInfo('-1.0.dist-info')).toBeNull();
  });
});

describe('payloadNamesFromRecord', () => {
  it('collects the top-level names a RECORD promises', () => {
    const record = [
      'torch/__init__.py,sha256=abc,1234',
      'torch/nn/functional.py,sha256=def,99',
      'torchgen/__init__.py,sha256=ghi,10',
      'functorch/__init__.py,sha256=jkl,10',
    ].join('\n');

    expect(payloadNamesFromRecord(record).sort()).toEqual(['functorch', 'torch', 'torchgen']);
  });

  it('keeps single-file modules, which have no directory of their own', () => {
    expect(payloadNamesFromRecord('six.py,sha256=abc,1\n')).toEqual(['six.py']);
  });

  it('skips metadata, caches and paths outside site-packages', () => {
    const record = [
      'torch/__init__.py,sha256=abc,1',
      'torch-2.13.0+cu130.dist-info/METADATA,sha256=abc,1',
      'torch-2.13.0+cu130.data/scripts/torchrun,sha256=abc,1',
      '__pycache__/six.cpython-313.pyc,,',
      '../../Scripts/vspipe.exe,sha256=abc,1',
    ].join('\n');

    expect(payloadNamesFromRecord(record)).toEqual(['torch']);
  });

  it('handles the quoted paths RECORD uses when a filename contains a comma', () => {
    expect(payloadNamesFromRecord('"weird,name/mod.py",sha256=abc,1\n')).toEqual(['weird,name']);
  });
});

describe('inspectPythonEnvironment', () => {
  let sitePackages: string;

  beforeEach(async () => {
    sitePackages = await fs.mkdtemp(path.join(os.tmpdir(), 'vk-env-'));
  });

  afterEach(async () => {
    await fs.rm(sitePackages, { recursive: true, force: true });
  });

  /** Writes a healthy distribution: metadata, RECORD, and the files it lists. */
  async function installPackage(
    distInfo: string,
    payload: string[],
    options: { metadata?: boolean; record?: boolean } = {}
  ): Promise<void> {
    const dir = path.join(sitePackages, distInfo);
    await fs.mkdir(dir, { recursive: true });

    if (options.metadata !== false) {
      await fs.writeFile(path.join(dir, 'METADATA'), 'Name: test\n');
    }
    if (options.record !== false) {
      const lines = payload.map(name => `${name}/__init__.py,sha256=abc,1`);
      await fs.writeFile(path.join(dir, 'RECORD'), `${lines.join('\n')}\n`);
    }
    for (const name of payload) {
      await fs.mkdir(path.join(sitePackages, name), { recursive: true });
    }
  }

  it('reports nothing for a healthy environment', async () => {
    await installPackage('torch-2.13.0.dist-info', ['torch', 'torchgen']);
    await installPackage('numpy-2.5.2.dist-info', ['numpy']);

    const report = await inspectPythonEnvironment(sitePackages);

    expect(report.problems).toEqual([]);
    expect(report.staleDirectories).toEqual([]);
  });

  it('catches the install killed before its RECORD was written', async () => {
    await installPackage('torch-2.13.0.dist-info', ['torch'], { record: false });

    const report = await inspectPythonEnvironment(sitePackages);

    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatchObject({ project: 'torch', kind: 'no-record' });
  });

  it('catches a dist-info with no METADATA, which pip reads as version None', async () => {
    await installPackage('torch-2.13.0.dist-info', ['torch'], { metadata: false });

    const report = await inspectPythonEnvironment(sitePackages);

    expect(report.problems[0]).toMatchObject({ project: 'torch', kind: 'no-metadata' });
  });

  it('catches intact metadata whose installed files have gone missing', async () => {
    await installPackage('torch-2.13.0.dist-info', ['torch', 'torchgen']);
    await fs.rm(path.join(sitePackages, 'torchgen'), { recursive: true });

    const report = await inspectPythonEnvironment(sitePackages);

    expect(report.problems[0]).toMatchObject({ project: 'torch', kind: 'missing-payload' });
    expect(report.problems[0].detail).toContain('torchgen');
  });

  it('accepts a distribution that installs no files into site-packages', async () => {
    // Console-script-only wheels put everything in Scripts/; there is nothing
    // here to verify, and absence of names must not read as damage.
    const dir = path.join(sitePackages, 'trtexec-1.0.dist-info');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'METADATA'), 'Name: trtexec\n');
    await fs.writeFile(path.join(dir, 'RECORD'), '../../Scripts/trtexec.exe,sha256=abc,1\n');

    expect((await inspectPythonEnvironment(sitePackages)).problems).toEqual([]);
  });

  it('finds the ~ directories an interrupted uninstall leaves behind', async () => {
    await installPackage('torch-2.13.0.dist-info', ['torch']);
    await fs.mkdir(path.join(sitePackages, '~orch'), { recursive: true });

    const report = await inspectPythonEnvironment(sitePackages);

    expect(report.problems).toEqual([]);
    expect(report.staleDirectories).toEqual(['~orch']);
  });

  it('treats a missing environment as empty rather than as damage', async () => {
    const report = await inspectPythonEnvironment(path.join(sitePackages, 'nope'));

    expect(report).toEqual({ problems: [], staleDirectories: [] });
  });

  it('names each broken project once, for the reinstall list', async () => {
    await installPackage('torch-2.13.0.dist-info', ['torch'], { record: false });
    await installPackage('vs_temporalfix-1.0.dist-info', ['vs_temporalfix'], { record: false });

    const report = await inspectPythonEnvironment(sitePackages);

    expect(brokenProjectNames(report)).toEqual(['torch', 'vs-temporalfix']);
  });

  it('repairs by clearing metadata and rubble, leaving healthy packages alone', async () => {
    await installPackage('torch-2.13.0.dist-info', ['torch'], { record: false });
    await installPackage('numpy-2.5.2.dist-info', ['numpy']);
    await fs.mkdir(path.join(sitePackages, '~orch'), { recursive: true });

    const report = await inspectPythonEnvironment(sitePackages);
    const result = await repairPythonEnvironment(sitePackages, report);

    expect(result.removed.sort()).toEqual(['torch-2.13.0.dist-info', '~orch']);
    expect(result.failed).toEqual([]);

    // The package files stay: pip reinstalls over them once the metadata that
    // was blocking it is gone.
    const remaining = (await fs.readdir(sitePackages)).sort();
    expect(remaining).toEqual(['numpy', 'numpy-2.5.2.dist-info', 'torch']);

    expect((await inspectPythonEnvironment(sitePackages)).problems).toEqual([]);
  });
});
