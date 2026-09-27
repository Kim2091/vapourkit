import * as fs from 'fs-extra';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { dir } = vi.hoisted(() => {
  const nodePath = require('path') as typeof import('path');
  const nodeOs = require('os') as typeof import('os');
  return { dir: nodePath.join(nodeOs.tmpdir(), `vk-templates-test-${process.pid}`) };
});

vi.mock('./constants', () => ({ PATHS: { FILTER_TEMPLATES: dir } }));
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { TemplateManager } from './templateManager';

const write = (file: string, name: string) =>
  fs.writeFile(path.join(dir, file), `name = "${name}"\ncode = "clip = clip"\n`);

describe('template files', () => {
  beforeEach(async () => { await fs.remove(dir); await fs.ensureDir(dir); });
  afterEach(async () => { await fs.remove(dir); });

  it('deletes a bundled template whose file is not named after it', async () => {
    await write('DeHalo Alpha (Old).vkfilter', 'DeHalo Alpha (Old)');
    await new TemplateManager().deleteTemplate('DeHalo Alpha (Old)');
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('saves an edit over the file that holds the template, not beside it', async () => {
    await write('Undistort _Pytorch_.vkfilter', 'Undistort (PyTorch)');
    await new TemplateManager().saveTemplate({ name: 'Undistort (PyTorch)', code: 'clip = mine' });
    expect(await fs.readdir(dir)).toEqual(['Undistort _Pytorch_.vkfilter']);
    expect(await fs.readFile(path.join(dir, 'Undistort _Pytorch_.vkfilter'), 'utf8')).toContain('clip = mine');
  });

  it('never saves over another template whose name sanitizes the same', async () => {
    await write('A _x_.vkfilter', 'A (x)');
    const manager = new TemplateManager();
    await manager.saveTemplate({ name: 'A [x]', code: 'clip = other' });
    await manager.deleteTemplate('A (x)');
    const names = (await manager.loadTemplates()).map(t => t.name);
    expect(names).toEqual(['A [x]']);
  });

  it('reports a template that has no file', async () => {
    await expect(new TemplateManager().deleteTemplate('Nothing')).rejects.toThrow('Template not found');
  });
});
