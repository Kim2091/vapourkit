// Every shipped .vkfilter, built against the real VapourSynth core.
//
// Opt-in: it needs the portable install, and the first run of a template with
// a TensorRT step will sit there building an engine. Set VK_VERIFY_FILTERS=1
// to run it:
//
//   VK_VERIFY_FILTERS=1 npx vitest run -c vitest.config.electron.ts \
//     electron/filterTemplates.integration.test.ts
//
// The work is done by scripts/verify_filters.py, which is also runnable by
// hand and is the better way to read the detail. This asserts on its report.
//
// About the baseline: a large part of the shipped catalog currently does not
// build, mostly because a plugin is not installed or because an upstream
// package renamed something. That is a real backlog, not something to hide,
// so it is checked in as filterTemplates.baseline.json and this test is a
// ratchet over it — a filter that newly breaks fails, and one that starts
// working fails too, so the list shrinks as the backlog is paid down and can
// never quietly grow.
//
// The baseline reflects a complete local install. On a machine missing
// optional plugins more filters will fail, and this test will say so; that is
// working as intended, but it is why it is not part of the default run.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const repo = path.resolve(__dirname, '..');
const python = path.join(repo, 'data', 'vapoursynth-portable', 'python.exe');
const sitePackages = path.join(repo, 'data', 'vapoursynth-portable', 'Lib', 'site-packages');
const script = path.join(repo, 'scripts', 'verify_filters.py');
const baselinePath = path.join(__dirname, 'filterTemplates.baseline.json');

const enabled = process.env.VK_VERIFY_FILTERS === '1' && fs.existsSync(python);

interface Result {
  file: string;
  name: string | null;
  verdict: 'ok' | 'skipped' | 'failed';
  why: string;
  detail: string;
}

function run(): Result[] {
  const out = path.join(os.tmpdir(), `vk-filters-${process.pid}.json`);
  // --render, not just graph construction. A filter that indexes around the
  // playhead builds fine and then fails at an edge; Add Duplicates did exactly
  // that, and pulling only frame 0 called it healthy.
  const result = spawnSync(python, [script, '--render', '--json', out], {
    cwd: repo,
    env: { ...process.env, PYTHONPATH: sitePackages },
    encoding: 'utf8',
    timeout: 900_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!fs.existsSync(out)) {
    throw new Error(
      `verify_filters.py wrote no report.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr?.slice(-4000)}`,
    );
  }
  const parsed = JSON.parse(fs.readFileSync(out, 'utf8')) as Result[];
  fs.rmSync(out, { force: true });
  return parsed;
}

describe.skipIf(!enabled)('shipped filter templates, against a real core', () => {
  const results = enabled ? run() : [];
  const named = (r: Result) => `${r.file} — ${r.why}: ${r.detail.slice(0, 160)}`;

  it('checked the whole catalog', () => {
    expect(results.length).toBeGreaterThan(100);
  });

  // These three are faults in the template itself, so no install can excuse
  // them and none is allowed even in the baseline.

  it('has no template that fails to parse', () => {
    const bad = results.filter(r => r.why === 'unparseable');
    expect(bad.map(named)).toEqual([]);
  });

  it('has no template whose code is not valid Python', () => {
    const bad = results.filter(r => r.why === 'syntax');
    expect(bad.map(named)).toEqual([]);
  });

  it('has no template that leaves no clip behind', () => {
    // The generated script goes on to use `clip`; a template that rebinds it
    // to None, or never assigns it, breaks the chain below it.
    const bad = results.filter(r => r.why === 'no clip');
    expect(bad.map(named)).toEqual([]);
  });

  it('breaks no filter that used to build', () => {
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as Record<string, string>;
    const regressed = results.filter(r => r.verdict === 'failed' && !(r.file in baseline));
    expect(
      regressed.map(named),
      'these filters build no longer — fix them, or add them to filterTemplates.baseline.json with a reason',
    ).toEqual([]);
  });

  it('keeps the baseline honest', () => {
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as Record<string, string>;
    const shipped = new Set(results.map(r => r.file));
    const healthy = new Set(results.filter(r => r.verdict === 'ok').map(r => r.file));

    const gone = Object.keys(baseline).filter(file => !shipped.has(file));
    expect(gone, 'baselined filters that are no longer shipped').toEqual([]);

    const fixed = Object.keys(baseline).filter(file => healthy.has(file));
    expect(
      fixed,
      'these build again — remove them from filterTemplates.baseline.json so they stay fixed',
    ).toEqual([]);
  });

  it('reports where the catalog stands', () => {
    const count = (v: Result['verdict']) => results.filter(r => r.verdict === v).length;
    const byReason = new Map<string, number>();
    for (const r of results.filter(x => x.verdict === 'failed')) {
      byReason.set(r.why, (byReason.get(r.why) ?? 0) + 1);
    }
    console.log(
      `filters: ${count('ok')} build, ${count('skipped')} refused for a good reason, `
      + `${count('failed')} failed`,
    );
    for (const [why, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${why}: ${n}`);
    }
    expect(count('ok')).toBeGreaterThan(0);
  });
});
