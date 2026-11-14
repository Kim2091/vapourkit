import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import { createHash } from 'crypto';
const { root, download } = vi.hoisted(() => ({ root: require('path').join(require('os').tmpdir(), 'vk-components-' + process.pid), download: vi.fn() }));
vi.mock('./constants', () => ({ PATHS: { APP_DATA: root, CONFIG: path.join(root, 'config'), MODELS: path.join(root, 'models') } }));
vi.mock('./configManager', () => ({ configManager: { getPluginsGpuVendor: () => 'unknown' } }));
vi.mock('./utils', () => ({ getBundledBasePath: () => root }));
vi.mock('./download', () => ({ downloadToFile: download }));
vi.mock('./logger', () => ({ logger: { model: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
import { selectedComponentRoot } from './componentPaths';
const text = 'name = "Example"\ncode = "clip = clip"\n';
const sha = createHash('sha256').update(text).digest('hex');
const entry = { id: 'example-filters', version: '1', name: 'Example filters', kind: 'filters', platforms: ['linux', 'win32'], vendors: ['unknown'], channel: 'stable', notes: '', license: 'MIT', files: [{ path: 'example.vkfilter', url: 'https://github.com/example/repo/releases/download/1/example.vkfilter', sha256: sha, bytes: Buffer.byteLength(text) }] };
beforeEach(async () => {
  vi.resetModules(); await fs.remove(root); await fs.ensureDir(path.join(root, 'include'));
  await fs.writeJson(path.join(root, 'include', 'component-catalog.json'), { schema: 1, client: 1, revision: 1, components: [entry] });
  download.mockReset().mockImplementation(async (_url: string, file: string) => { await fs.outputFile(file, text); });
});
afterAll(async () => { await fs.remove(root); vi.unstubAllGlobals(); });
describe('transactional component updates', () => {
  it('downloads approved hashes, stages selection until restart, and retains a rollback', async () => {
    const service = await import('./componentUpdates');
    await service.checkComponents(false); await service.installComponent(entry.id, '1', false);
    expect(download.mock.calls[0][2].expectedSha256).toBe(sha);
    const installed = path.join(root, 'components', 'example-filters@1');
    expect(selectedComponentRoot(root, 'filters', 'legacy')).toBe(installed);
    expect((await service.checkComponents(false)).pendingRestart).toBe(true);
    await service.rollbackComponent('filters');
    expect(selectedComponentRoot(root, 'filters', 'legacy')).toBe('legacy');
    expect(await fs.pathExists(path.join(installed, 'example.vkfilter'))).toBe(true);
  });
  it('keeps the active component after a failed download and removes staging files', async () => {
    const service = await import('./componentUpdates'); await service.checkComponents(false);
    download.mockRejectedValueOnce(new Error('Checksum mismatch'));
    await expect(service.installComponent(entry.id, '1', false)).rejects.toThrow('Checksum');
    expect(selectedComponentRoot(root, 'filters', 'legacy')).toBe('legacy');
    expect(await fs.pathExists(path.join(root, 'config', 'component-selection.json'))).toBe(false);
    expect((await fs.readdir(path.join(root, 'components'))).some(f => f.includes('staging'))).toBe(false);
  });
  it('preserves user-edited templates while overlaying an approved unedited version', async () => {
    const old = 'name = "Example"\ncode = "old"\n';
    const oldSha = createHash('sha256').update(old).digest('hex');
    const catalogFile = path.join(root, 'include', 'component-catalog.json');
    const catalog = await fs.readJson(catalogFile); catalog.components[0].replaces = { Example: [oldSha] }; await fs.writeJson(catalogFile, catalog);
    let service = await import('./componentUpdates'); await service.checkComponents(false); await service.installComponent(entry.id, '1', false);
    vi.resetModules(); service = await import('./componentUpdates');
    const oldFile = path.join(root, 'custom.vkfilter'); await fs.writeFile(oldFile, old);
    expect((await service.overlayComponentFilters([{ name: 'Example', code: 'old' }], new Map([['Example', oldFile]])))[0].code).toBe('clip = clip');
    await fs.writeFile(oldFile, 'edited');
    expect((await service.overlayComponentFilters([{ name: 'Example', code: 'my edit' }], new Map([['Example', oldFile]])))[0].code).toBe('my edit');
  });
});
