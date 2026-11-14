import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
vi.mock('./logger', () => ({ logger: { model: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { inspectOnnxGraph } from './onnxGraphInspector';
import { importModelPackage, modelPackageFiles, listModelFiles } from './modelPackage';
const varint = (n: number): Buffer => { const b: number[] = []; do { b.push((n & 127) | (n > 127 ? 128 : 0)); n = Math.floor(n / 128); } while (n); return Buffer.from(b); };
const field = (n: number, b: Buffer) => Buffer.concat([varint(n * 8 + 2), varint(b.length), b]);
const str = (n: number, s: string) => field(n, Buffer.from(s));
const num = (n: number, v: number) => Buffer.concat([varint(n * 8), varint(v)]);
const binding = (name: string, channels: number) => Buffer.concat([str(1, name), field(2, field(1, Buffer.concat([num(1, 1), field(2, Buffer.concat([1, channels, 'h', 'w'].map(d => field(1, typeof d === 'number' ? num(1, d) : str(2, d)))))])))]);
const fixture = (location: string) => field(7, Buffer.concat([
  field(5, Buffer.concat([str(8, 'weights'), num(2, 1), field(13, Buffer.concat([str(1, 'location'), str(2, location)]))])),
  field(11, binding('weights', 3)), field(11, binding('pixels', 3)), field(12, binding('result', 3)),
]));
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.remove(dir); });
async function setup(location = 'weights.bin') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vk-model-package-')); dirs.push(dir);
  await fs.writeFile(path.join(dir, 'model.onnx'), fixture(location));
  await fs.writeFile(path.join(dir, 'weights.bin'), Buffer.from([0, 0, 128, 63])); return dir;
}
describe('complete ONNX packages', () => {
  it('retains all data inputs/outputs and excludes initializer inputs', async () => {
    const dir = await setup(); const info = inspectOnnxGraph(path.join(dir, 'model.onnx'))!;
    expect(info.inputs.map(i => i.name)).toEqual(['pixels']); expect(info.outputs[0].name).toBe('result');
    expect(info.externalData).toEqual(['weights.bin']);
  });
  it('imports weights without collisions and keeps earlier versions unchanged', async () => {
    const dir = await setup(); const root = path.join(dir, 'installed');
    const a = await importModelPackage(path.join(dir, 'model.onnx'), root, 'Example');
    await fs.writeFile(path.join(dir, 'weights.bin'), Buffer.from([0, 0, 0, 64]));
    const b = await importModelPackage(path.join(dir, 'model.onnx'), root, 'Example');
    expect(a).not.toBe(b);
    expect(await fs.readFile(path.join(path.dirname(a), 'weights.bin'))).toEqual(Buffer.from([0, 0, 128, 63]));
    expect(await fs.readFile(path.join(path.dirname(b), 'weights.bin'))).toEqual(Buffer.from([0, 0, 0, 64]));
    await fs.ensureDir(path.join(path.dirname(b), 'engines'));
    await fs.writeFile(path.join(path.dirname(b), 'engines', 'cached.engine'), 'cache');
    expect((await listModelFiles(root)).some(f => f.endsWith('cached.engine'))).toBe(false);
  });
  it('rejects incomplete and escaping packages before copying', async () => {
    const dir = await setup('../outside.bin');
    await expect(modelPackageFiles(path.join(dir, 'model.onnx'))).rejects.toThrow('inside');
    await fs.writeFile(path.join(dir, 'model.onnx'), fixture('missing.bin'));
    await expect(modelPackageFiles(path.join(dir, 'model.onnx'))).rejects.toThrow('Missing external weights');
  });
});
