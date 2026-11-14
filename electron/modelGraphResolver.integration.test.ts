import { afterAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
const fixture = vi.hoisted(() => ({ python: process.env.VK_MODEL_TEST_PYTHON, model: process.env.VK_ADORE_TEST_MODEL }));
vi.mock('./constants', async () => {
  const path = await import('path'); const os = await import('os');
  return { IS_WINDOWS: process.platform === 'win32', PATHS: { PYTHON: fixture.python, APP_DATA: path.join(os.tmpdir(), `vk-adore-import-${process.pid}`) } };
});
vi.mock('./logger', () => ({ logger: { model: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./utils', () => ({ getBundledBasePath: () => process.cwd() }));
import { inspectResolvedOnnxGraph } from './modelGraphResolver';
import { importModelPackage, fileDigest } from './modelPackage';
import { describeModel } from './modelContract';
const root = path.join(os.tmpdir(), `vk-adore-import-${process.pid}`);
afterAll(async () => { await fs.remove(root); });
describe.skipIf(!fixture.python || !fixture.model)('official Adore import with real Python shape inference', () => {
  it('accepts symbolic output channels as an image model', async () => {
    const graph = await inspectResolvedOnnxGraph(fixture.model!);
    expect(describeModel(graph!, { modelType: 'image', temporalFrames: 1 }).outputs[0].shape[1]).toBe(3);
  });
  it('imports the complete immutable package and saves its resolved contract', async () => {
    const before = await fileDigest(fixture.model!);
    const installed = await importModelPackage(fixture.model!, path.join(root, 'models'), 'Adore-fp16');
    const contract = await fs.readJson(installed + '.contract.json');
    expect(contract.temporalFrames).toBe(1);
    expect(contract.outputs[0].shape[1]).toBe(3);
    expect(await fileDigest(installed)).toBe(before);
    expect(await fileDigest(fixture.model!)).toBe(before);
  });
});
