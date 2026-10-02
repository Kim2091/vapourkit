// The template half of an update, run for real against a 2.0.0 install.
//
// Bundle and data\ both live in a temp root: the bundle is copied from this
// checkout, the installed templates are what v2.0.0 shipped, plus two edits
// and a template of the user's own. What the update may touch, what it must
// leave alone and what it has to ask about are all checked on disk.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Hoisted with the mocks, which read it while the modules under test load.
const { root } = vi.hoisted(() => {
  const fsh = require('fs') as typeof import('fs');
  const osh = require('os') as typeof import('os');
  const pathh = require('path') as typeof import('path');
  return { root: fsh.mkdtempSync(pathh.join(osh.tmpdir(), 'vk-template-update-')) };
});
const repoRoot = path.resolve(__dirname, '..');

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => root,
    getPath: () => root,
    getVersion: () => '2.1.0',
  },
  BrowserWindow: class {},
}));

vi.mock('./logger', () => ({
  logger: new Proxy({}, { get: () => vi.fn() }),
}));

// getBundledBasePath reaches electron through a runtime require, which the
// mock above does not intercept.
vi.mock('./utils', async (importOriginal) => ({
  ...await importOriginal<typeof import('./utils')>(),
  getBundledBasePath: () => root,
}));

vi.mock('./configManager', () => ({
  configManager: { getAppVersion: () => '2.0.0' },
}));

import { DependencyManager } from './dependencyManager';
import { emptyReportDraft, markTemplateDeletedByUser, readLedger } from './installLedger';

const installed = path.join(root, 'data', 'config', 'filter-templates');
const hasTag = (() => {
  try {
    execFileSync('git', ['rev-parse', '--verify', 'v2.0.0'], { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// Each step digests the real template tree; slow under a parallel run.
describe.skipIf(!hasTag)('updating a 2.0.0 install', { timeout: 30_000 }, () => {
  const manager = new DependencyManager() as unknown as {
    copyFilterTemplates(base: string, report?: ReturnType<typeof emptyReportDraft>): Promise<void>;
    getTemplateDecisions(): ReturnType<DependencyManager['getTemplateDecisions']>;
    resolveTemplateDecision: DependencyManager['resolveTemplateDecision'];
    restoreMissingBundledTemplates: DependencyManager['restoreMissingBundledTemplates'];
  };
  const report = emptyReportDraft();
  const bundledQtgmc = path.join(root, 'include', 'plugins', 'plugin_filters', 'QTGMC _Old_.vkfilter');

  beforeAll(async () => {
    for (const dir of ['include/filter_templates', 'include/plugins/plugin_filters']) {
      fs.cpSync(path.join(repoRoot, dir), path.join(root, dir), { recursive: true });
    }

    fs.mkdirSync(installed, { recursive: true });
    for (const dir of ['include/filter_templates', 'include/plugins/plugin_filters']) {
      const listing = execFileSync('git', ['ls-tree', '--name-only', 'v2.0.0', `${dir}/`], { cwd: repoRoot, encoding: 'utf8' });
      for (const file of listing.split('\n').filter(f => f.endsWith('.vkfilter'))) {
        fs.writeFileSync(
          path.join(installed, path.basename(file)),
          execFileSync('git', ['show', `v2.0.0:${file}`], { cwd: repoRoot, encoding: 'utf8' }),
        );
      }
    }
    // A fix 2.1 made underneath an edit, a filter 2.1 dropped that was
    // edited, and a template that was never ours.
    fs.appendFileSync(path.join(installed, 'QTGMC _Old_.vkfilter'), '\n# my tweak\n');
    fs.appendFileSync(path.join(installed, 'TFMBobN.vkfilter'), '\n# my tweak\n');
    fs.writeFileSync(path.join(installed, 'Mine.vkfilter'), 'name = "Mine"\ncode = "clip = clip"\n');

    await manager.copyFilterTemplates(root, report);
  }, 60_000); // copies the real template tree; slow under a parallel run

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('updates the untouched templates 2.1 fixed, and removes the untouched ones it dropped', () => {
    expect(report.templatesUpdated).toContain('Guided Filter.vkfilter');
    expect(report.templatesUpdated).not.toContain('QTGMC _Old_.vkfilter');
    expect(report.templatesRemoved).toContain('TFMBobQ.vkfilter');
    expect(report.templatesRemoved).toContain('Crop _auto_.vkfilter');
    // 2.1 changed 41 of 2.0.0's templates and dropped 14; less the two edited.
    expect(report.templatesUpdated).toHaveLength(40);
    expect(report.templatesRemoved).toHaveLength(13);
    expect(report.templatesRemoved).not.toContain('TFMBobN.vkfilter');
    expect(fs.existsSync(path.join(installed, 'TFMBobQ.vkfilter'))).toBe(false);
    expect(report.templatesAdded).toContain('DLSS Neural Uplift.vkfilter');
  });

  it('leaves both edits and the user\'s own template on disk', () => {
    expect(fs.readFileSync(path.join(installed, 'QTGMC _Old_.vkfilter'), 'utf8')).toContain('# my tweak');
    expect(fs.readFileSync(path.join(installed, 'TFMBobN.vkfilter'), 'utf8')).toContain('# my tweak');
    expect(fs.existsSync(path.join(installed, 'Mine.vkfilter'))).toBe(true);
  });

  it('records a ledger entry for every seeded template, and none for the user\'s own', async () => {
    const ledger = await readLedger();
    expect(ledger.templates['Guided Filter.vkfilter']?.appVersion).toBe('2.1.0');
    expect(ledger.templates['Mine.vkfilter']).toBeUndefined();
  });

  it('asks about exactly the two edits', async () => {
    const decisions = await manager.getTemplateDecisions();
    expect(decisions.map(d => [d.file, d.kind])).toEqual([
      ['QTGMC _Old_.vkfilter', 'edited-outdated'],
      ['TFMBobN.vkfilter', 'edited-dropped'],
    ]);
    expect(decisions[0].name).toBe('QTGMC (Old)');
  });

  it('replaces an edit with the new version, keeping the edit as a backup', async () => {
    const { backupPath } = await manager.resolveTemplateDecision('QTGMC _Old_.vkfilter', 'replace');
    expect(fs.readFileSync(backupPath!, 'utf8')).toContain('# my tweak');
    expect(fs.readFileSync(path.join(installed, 'QTGMC _Old_.vkfilter'))).toEqual(fs.readFileSync(bundledQtgmc));
  });

  it('keeps a dropped edit, and then stops asking and never removes it', async () => {
    await manager.resolveTemplateDecision('TFMBobN.vkfilter', 'keep');
    expect(await manager.getTemplateDecisions()).toEqual([]);

    const again = emptyReportDraft();
    await manager.copyFilterTemplates(root, again);
    expect(fs.existsSync(path.join(installed, 'TFMBobN.vkfilter'))).toBe(true);
    expect(again).toEqual(emptyReportDraft());
  });

  it('puts back a template that vanished without being deleted in the app', async () => {
    fs.rmSync(path.join(installed, 'Guided Filter.vkfilter'));
    await manager.copyFilterTemplates(root, emptyReportDraft());
    expect(fs.existsSync(path.join(installed, 'Guided Filter.vkfilter'))).toBe(true);
  });

  it('does not bring back a template the user deleted in the app', async () => {
    fs.rmSync(path.join(installed, 'Guided Filter.vkfilter'));
    await markTemplateDeletedByUser('Guided Filter.vkfilter');
    await manager.copyFilterTemplates(root, emptyReportDraft());
    expect(fs.existsSync(path.join(installed, 'Guided Filter.vkfilter'))).toBe(false);
    // Until the user asks for it back.
    expect(await manager.restoreMissingBundledTemplates()).toEqual(['Guided Filter.vkfilter']);
    expect(fs.existsSync(path.join(installed, 'Guided Filter.vkfilter'))).toBe(true);
  });

  it('says nothing about an edit made to the current body', async () => {
    fs.appendFileSync(path.join(installed, 'Crop.vkfilter'), '\n# my tweak\n');
    expect((await manager.getTemplateDecisions()).map(d => d.file)).toEqual([]);
  });
});
