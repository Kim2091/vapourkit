import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const p = await import('path');
  const o = await import('os');
  const root = p.join(o.tmpdir(), `vk-script-sync-test-${process.pid}`);
  return { app: { isPackaged: false, getAppPath: () => root, getPath: () => root, getVersion: () => '2.1.0' } };
});
vi.mock('./logger', () => ({ logger: new Proxy({}, { get: () => vi.fn() }) }));

import { planScriptSync, syncScriptSources, type ScriptLedgerEntry } from './scriptSync';
import { SCRIPT_SOURCE_MANIFEST } from './scriptSourceManifest';
import { BUNDLED_SCRIPT_ARCHIVES, HYBRID_SCRIPTS_COMMIT, HYBRID_SCRIPTS_SOURCE, isSupersededScript, type ScriptSourceManifestEntry } from './scriptSources';

const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const manifest = { version: 'v2', files: { 'a.py': sha('a2'), 'b.py': sha('b2') } };
const entry = (files: Record<string, string>): ScriptLedgerEntry => ({ version: 'v1', appVersion: '2.1.0', files });

describe('planning a vs-scripts source', () => {
  it('writes what is missing, and leaves what is current', () => {
    const plan = planScriptSync(manifest, new Map([['a.py', sha('a2')]]), undefined);
    expect(plan.write).toEqual(['b.py']);
    expect(plan.files).toEqual(manifest.files);
  });

  it('replaces an untouched stale file', () => {
    const plan = planScriptSync(manifest, new Map([['a.py', sha('a1')], ['b.py', sha('b2')]]), entry({ 'a.py': sha('a1') }));
    expect(plan.write).toEqual(['a.py']);
  });

  it('keeps an edit on an update, and replaces it on a reinstall', () => {
    const installed = new Map([['a.py', sha('mine')], ['b.py', sha('b2')]]);
    const recorded = entry({ 'a.py': sha('a1'), 'b.py': sha('b2') });
    expect(planScriptSync(manifest, installed, recorded)).toMatchObject({ write: [], keptEdited: ['a.py'] });
    expect(planScriptSync(manifest, installed, recorded, true)).toMatchObject({ write: ['a.py'], keptEdited: [] });
  });

  it('treats a difference with no record as an edit, based on what ships now', () => {
    const plan = planScriptSync(manifest, new Map([['a.py', sha('mine')], ['b.py', sha('b2')]]), undefined);
    expect(plan).toMatchObject({ write: [], keptEdited: ['a.py'] });
    expect(plan.files['a.py']).toBe(sha('a2'));
    // ...so the next release still sees an edit, not an untouched file of ours.
    const next = { version: 'v3', files: { 'a.py': sha('a3'), 'b.py': sha('b2') } };
    expect(planScriptSync(next, new Map([['a.py', sha('mine')], ['b.py', sha('b2')]]), entry(plan.files)).keptEdited).toEqual(['a.py']);
  });

  it('removes an untouched file the source no longer ships, and keeps an edited one', () => {
    const recorded = entry({ 'a.py': sha('a2'), 'b.py': sha('b2'), 'old.py': sha('o'), 'mine.py': sha('m') });
    const installed = new Map([['a.py', sha('a2')], ['b.py', sha('b2')], ['old.py', sha('o')], ['mine.py', sha('edited')]]);
    expect(planScriptSync(manifest, installed, recorded).remove).toEqual(['old.py']);
  });
});

describe('syncing vs-scripts', () => {
  function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-script-sync-'));
    const scriptsDir = path.join(root, 'vs-scripts');
    const bundled = path.join(root, 'bundle');
    fs.mkdirSync(bundled, { recursive: true });
    fs.writeFileSync(path.join(bundled, 'extra.7z'), 'archive');
    const manifest: Record<string, ScriptSourceManifestEntry> = {
      [HYBRID_SCRIPTS_SOURCE]: { version: 'c1', files: { 'havsfunc.py': sha('h2') } },
      [BUNDLED_SCRIPT_ARCHIVES[0]]: { version: 'z1', files: { 'pkg/__init__.py': sha('p2') } },
    };
    const downloads: string[] = [];
    const options = {
      scriptsDir,
      bundledScriptsDir: bundled,
      backupDir: path.join(root, 'backups'),
      tempDir: root,
      appVersion: '2.1.0',
      mode: 'update' as const,
      ledger: {} as Record<string, ScriptLedgerEntry>,
      manifest,
      download: async (url: string, dest: string) => { downloads.push(url); fs.writeFileSync(dest, 'zip'); },
      unpack: async (archive: string, into: string) => {
        if (archive.endsWith('.zip')) {
          fs.mkdirSync(path.join(into, 'repo', 'nested'), { recursive: true });
          fs.writeFileSync(path.join(into, 'repo', 'nested', 'havsfunc.py'), 'h2');
        } else {
          fs.mkdirSync(path.join(into, 'pkg'), { recursive: true });
          fs.writeFileSync(path.join(into, 'pkg', '__init__.py'), 'p2');
        }
      },
    };
    return { root, scriptsDir, options, downloads };
  }

  it('installs every source into an empty folder and records it', async () => {
    const { root, scriptsDir, options } = setup();
    try {
      const result = await syncScriptSources(options);
      expect(result.updated.sort()).toEqual(['havsfunc.py', 'pkg/__init__.py']);
      expect(fs.readFileSync(path.join(scriptsDir, 'pkg', '__init__.py'), 'utf8')).toBe('p2');
      expect(options.ledger[HYBRID_SCRIPTS_SOURCE]).toMatchObject({ version: 'c1', files: { 'havsfunc.py': sha('h2') } });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('downloads nothing when every file is already current', async () => {
    const { root, options, downloads } = setup();
    try {
      await syncScriptSources(options);
      downloads.length = 0;
      const again = await syncScriptSources(options);
      expect(downloads).toEqual([]);
      expect(again.updated).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps an edited script on an update, and backs it up before a reinstall replaces it', async () => {
    const { root, scriptsDir, options } = setup();
    try {
      await syncScriptSources(options);
      fs.writeFileSync(path.join(scriptsDir, 'havsfunc.py'), 'mine');
      expect((await syncScriptSources(options)).keptEdited).toEqual(['havsfunc.py']);
      expect(fs.readFileSync(path.join(scriptsDir, 'havsfunc.py'), 'utf8')).toBe('mine');

      await syncScriptSources({ ...options, mode: 'install' });
      expect(fs.readFileSync(path.join(scriptsDir, 'havsfunc.py'), 'utf8')).toBe('h2');
      expect(fs.readFileSync(path.join(root, 'backups', 'havsfunc.py'), 'utf8')).toBe('mine');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves a source that fails to download as it was, and still syncs the others', async () => {
    const { root, options } = setup();
    try {
      const result = await syncScriptSources({ ...options, download: async () => { throw new Error('offline'); } });
      expect(result.failed).toEqual([{ source: HYBRID_SCRIPTS_SOURCE, error: 'offline' }]);
      expect(options.ledger[HYBRID_SCRIPTS_SOURCE]).toBeUndefined();
      expect(result.updated).toEqual(['pkg/__init__.py']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the shipped script manifest', () => {
  const repoRoot = path.resolve(__dirname, '..');

  it('never installs a module PyPI now provides', () => {
    for (const entry of Object.values(SCRIPT_SOURCE_MANIFEST)) {
      expect(Object.keys(entry.files).filter(isSupersededScript)).toEqual([]);
    }
    expect(planScriptSync({ version: 'v', files: { 'vs_colorfix.py': sha('x'), 'vs_temporalfix/__init__.py': sha('y') } }, new Map(), undefined).write)
      .toEqual([]);
  });

  it('is for the pinned Hybrid scripts commit', () => {
    expect(SCRIPT_SOURCE_MANIFEST[HYBRID_SCRIPTS_SOURCE]?.version, 'run: npx tsx scripts/generateScriptManifest.ts')
      .toBe(HYBRID_SCRIPTS_COMMIT);
  });

  it('is for the bundled script archives as they are now', () => {
    for (const archive of BUNDLED_SCRIPT_ARCHIVES) {
      const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(repoRoot, 'include', 'scripts', archive))).digest('hex');
      expect(SCRIPT_SOURCE_MANIFEST[archive]?.version, `${archive} changed - run: npx tsx scripts/generateScriptManifest.ts`).toBe(digest);
    }
  });
});
