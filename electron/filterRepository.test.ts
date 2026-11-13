
import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
const mocks = vi.hoisted(() => ({ download: vi.fn(), exec: vi.fn(), cmd: vi.fn(), list: vi.fn(), save: vi.fn(), remove: vi.fn() }));
vi.mock('child_process', () => ({ execFile: mocks.exec }));
vi.mock('./download', () => ({ downloadToFile: mocks.download }));
vi.mock('7zip-min', () => ({ default: { cmd: mocks.cmd, list: mocks.list } }));
vi.mock('./constants', async () => {
  const p = await import('path'); const o = await import('os');
  const root = p.join(o.tmpdir(), 'vk-vsrepo-' + process.pid);
  return { PATHS: { PYTHON: 'python', CONFIG: p.join(root,'config'), SCRIPTS: p.join(root,'scripts'), PLUGINS: p.join(root,'plugins'), SITE_PACKAGES: p.join(root,'site') } };
});
vi.mock('./utils', () => ({ setupVSEnvironment: () => ({}) }));
vi.mock('./logger', () => ({ logger: { model: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./templateManager', () => ({ TemplateManager: class { async loadTemplates() { return []; } saveTemplate = mocks.save; deleteTemplate = mocks.remove; } }));
const root = path.join(os.tmpdir(), 'vk-vsrepo-' + process.pid);
const content = Buffer.from('verified native plugin fixture');
const sha = createHash('sha256').update(content).digest('hex');
const filename = process.platform === 'win32' ? 'newblur.dll' : 'newblur.so';
const binary = { api: 4, url: 'https://github.com/test/plugin/releases/download/1/plugin.zip', files: { [filename]: [filename, sha] } };
const entry = { name: 'New blur', identifier: 'test.newblur', type: 'VSPlugin', namespace: 'newblur', api: 4, releases: [{ version:'1', win64:binary, 'linux-glibc-x86_64':binary }] };
let registry: unknown;
beforeEach(async () => {
  vi.resetModules(); await fs.remove(root);
  registry = { 'file-format': 3, packages: [entry] };
  mocks.download.mockReset().mockImplementation(async (_url, file) => { await fs.outputFile(file, 'archive'); });
  mocks.cmd.mockReset().mockImplementation(async args => {
    const folder = args.find((a: string) => a.startsWith('-o')).slice(2);
    if (args.includes('vspackages3.json')) await fs.outputJson(path.join(folder, 'vspackages3.json'), registry);
    else await fs.outputFile(path.join(folder, filename), content);
    return '';
  });
  mocks.list.mockReset().mockResolvedValue([{ name: filename, size: String(content.length) }]);
  mocks.exec.mockReset().mockImplementation((_python, args, _options, done) => done(null, args[2].includes('result=[]') ? JSON.stringify([{ namespace:'newblur', functions:[{name:'Blur',signature:'clip:vnode;radius:int:opt;'}] }]) : '[]', ''));
  mocks.save.mockReset().mockResolvedValue(undefined); mocks.remove.mockReset().mockResolvedValue(undefined);
});
afterAll(async () => { await fs.remove(root); });
describe('staged VSRepo installation', () => {
  it('verifies files and plugin loading before publishing a usable filter template', async () => {
    const service = await import('./filterRepository');
    const entries = await service.listRepository(true);
    expect(entries[0].compatible).toBe(true);
    await service.installRepositoryPackage('test.newblur');
    expect(await fs.readFile(path.join(root,'plugins',filename))).toEqual(content);
    expect(mocks.save.mock.calls[0][0].code).toBe('clip = core.newblur.Blur(clip)');
  });
  it('keeps an existing plugin and refuses overwriting it', async () => {
    await fs.outputFile(path.join(root,'plugins',filename), 'user plugin');
    const service = await import('./filterRepository'); await service.listRepository(true);
    await expect(service.installRepositoryPackage('test.newblur')).rejects.toThrow('overwritten');
    expect(await fs.readFile(path.join(root,'plugins',filename), 'utf8')).toBe('user plugin');
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('does not publish failed checksum downloads', async () => {
    const service = await import('./filterRepository'); await service.listRepository(true);
    mocks.cmd.mockImplementation(async args => { const folder=args.find((a: string)=>a.startsWith('-o')).slice(2); await fs.outputFile(path.join(folder,filename), 'corrupt'); return ''; });
    await expect(service.installRepositoryPackage('test.newblur')).rejects.toThrow('Checksum');
    expect(await fs.pathExists(path.join(root,'plugins',filename))).toBe(false);
  });
  it('blocks unresolved dependencies before starting any plugin download', async () => {
    registry = { 'file-format': 3, packages: [{ ...entry, dependencies:['missing.plugin'] }] };
    const service = await import('./filterRepository'); const rows=await service.listRepository(true);
    expect(rows[0].compatible).toBe(false);
    const before=mocks.download.mock.calls.length;
    await expect(service.installRepositoryPackage('test.newblur')).rejects.toThrow('dependency is not in VSRepo');
    expect(mocks.download.mock.calls.length).toBe(before);
  });
  it('installs direct Python script assets with the same checksum and load checks', async () => {
    const script = { name:'New script', identifier:'newscript', type:'PyScript', modulename:'newscript', releases:[{version:'1',script:{url:'https://raw.githubusercontent.com/test/repo/commit/newscript.py',files:{'newscript.py':['newscript.py',sha]}}}] };
    registry = { 'file-format':3, packages:[script] };
    mocks.download.mockImplementation(async (url,file) => { await fs.outputFile(file, url.endsWith('newscript.py') ? content : Buffer.from('archive')); });
    mocks.exec.mockImplementation((_python,_args,_options,done) => done(null,'[]',''));
    const service=await import('./filterRepository');
    await service.listRepository(true);
    await service.installRepositoryPackage('newscript');
    expect(await fs.readFile(path.join(root,'scripts','newscript.py'))).toEqual(content);
    expect(mocks.list).not.toHaveBeenCalled();
  });

});
