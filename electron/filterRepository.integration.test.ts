
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
const environment = vi.hoisted(() => ({ python: process.env.VK_VSREPO_PYTHON, root: process.env.VK_VSREPO_ROOT, plugins: process.env.VK_VSREPO_PLUGINS }));
vi.mock('./constants', async () => {
  const p = await import('path'); const o = await import('os');
  const root = environment.root ?? p.join(o.tmpdir(),'vk-vsrepo-inactive');
  return { PATHS: { PYTHON: environment.python, APP_DATA:root, CONFIG:p.join(root,'config'), SCRIPTS:p.join(root,'scripts'), PLUGINS:environment.plugins, SITE_PACKAGES:p.dirname(p.dirname(environment.plugins ?? root)) } };
});
vi.mock('./utils', () => ({ setupVSEnvironment: () => ({ ...process.env }) }));
vi.mock('./logger', () => ({ logger: { model:vi.fn(),info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn() } }));
// Native publication/load are real; template persistence has separate unit coverage.
vi.mock('./templateManager', () => ({ TemplateManager:class { async loadTemplates(){return [];} async saveTemplate(){} async deleteTemplate(){} } }));
import { listRepository, installRepositoryPackage } from './filterRepository';
afterAll(async () => { if(environment.root) await fs.remove(path.join(environment.root,'config')); });
describe.skipIf(!environment.python)('VSRepo real native plugin installation', () => {
  it('downloads, verifies, stages and loads VIVTC in the private runtime', async () => {
    const rows = await listRepository(true);
    const target = rows.find(p => p.namespace === 'vivtc' && p.compatible && !p.installed);
    expect(target, 'Official registry must contain a compatible VIVTC fixture').toBeDefined();
    await fs.ensureDir(environment.plugins!);
    const result = await installRepositoryPackage(target!.id);
    expect(result.message).toContain('Installed');
    // A second fresh interpreter must discover the published native plugin.
    const loaded = await listRepository(false);
    expect(loaded.find(p => p.id === target!.id)?.installed).toBe(true);
  }, 180000);
  it('loads the legacy API3 CTMF plugin on the pinned R79 core', async () => {
    const rows = await listRepository(true);
    const target = rows.find(p => p.namespace === 'ctmf' && p.compatible && !p.installed);
    expect(target).toBeDefined();
    expect(target!.api).toBe(3);
    await installRepositoryPackage(target!.id);
    expect((await listRepository(false)).find(p => p.id === target!.id)?.installed).toBe(true);
  }, 180000);

});
