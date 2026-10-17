// The reconcile covers the targeted template migrations that came before
// the install ledger.
//
// Those migrations replaced Crop and Color Grade, and removed Crop (auto),
// when the template's `code` matched a body we had shipped. Every body git
// has carried with that code is in the shipped history, so the reconcile
// reaches the same result for each of them on an install with no ledger:
// Crop and Color Grade are updated, Crop (auto) is removed. A copy whose code
// matches but whose metadata was edited is an edit, which the reconcile asks
// about instead of overwriting.

import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as TOML from '@iarna/toml';
import { describe, expect, it } from 'vitest';
import { SHIPPED_TEMPLATE_DIGESTS } from './shippedTemplateDigests';
import { shippedTemplateDigest } from './shippedTemplateDigest';
import { planTemplateReconcile } from './templateReconcile';

const repoRoot = path.resolve(__dirname, '..');
const templateDirectories = ['include/filter_templates', 'include/plugins/plugin_filters'];

/** The code-only digests the migrations matched, by template. */
const MIGRATED_CODE: Record<string, { codes: string[]; expected: 'update' | 'remove' }> = {
  'Crop.vkfilter': {
    codes: [
      '31c8ecddb66c63494f7aa0b22773f80b0662f2c85cbbb575f1274c5c7d619844',
      '6be48f6f8ef228f95ca3d75cf57503ee5a951b7a212fb629925b9565337124df',
      'e0784187435aa7907c329baaa409bb2e17d93e07be43aa78ead6deafaa9ea8d6',
      '849c96a9fc7975ade2890f127d4e484617ccc86297588451a6edb210e98c04da',
    ],
    expected: 'update',
  },
  'Color Grade.vkfilter': {
    codes: ['741f8c831597afcdb1f00b09bf57fdcbcdb3aceeb2dc873ac4242dbc16555428'],
    expected: 'update',
  },
  'Crop _auto_.vkfilter': {
    codes: ['ba5a851bbdc067320b1217b9750684834be3e8c01efb98af4279a28462ca863e'],
    expected: 'remove',
  },
};

const git = (args: string[]) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const hasHistory = (() => {
  try {
    return git(['rev-parse', '--is-shallow-repository']).trim() === 'false';
  } catch {
    return false;
  }
})();

function codeDigest(text: string): string | null {
  try {
    const code = (TOML.parse(text) as { code?: unknown }).code;
    if (typeof code !== 'string') return null;
    return crypto.createHash('sha256').update(code.replace(/\r\n?/g, '\n').trim()).digest('hex');
  } catch {
    return null;
  }
}

/** Every body git has carried for a template, by whole-file digest. */
function historicalBodies(file: string): Map<string, string> {
  const paths = templateDirectories.map(dir => `${dir}/${file}`);
  const bodies = new Map<string, string>();
  for (const commit of git(['rev-list', 'HEAD', '--', ...paths]).split('\n').filter(Boolean)) {
    for (const candidate of paths) {
      let text: string;
      try {
        text = execFileSync('git', ['show', `${commit}:${candidate}`], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        continue;
      }
      bodies.set(shippedTemplateDigest(text), text);
    }
  }
  return bodies;
}

function bundledNow(): Map<string, string> {
  const bundled = new Map<string, string>();
  for (const dir of templateDirectories) {
    for (const file of fs.readdirSync(path.join(repoRoot, dir)).filter(f => f.endsWith('.vkfilter'))) {
      bundled.set(file, shippedTemplateDigest(fs.readFileSync(path.join(repoRoot, dir, file))));
    }
  }
  return bundled;
}

describe.skipIf(!hasHistory)('the pre-ledger template migrations', { timeout: 30_000 }, () => {
  const bundled = bundledNow();

  for (const [file, { codes, expected }] of Object.entries(MIGRATED_CODE)) {
    it(`${expected === 'update' ? 'updates' : 'removes'} every shipped ${file} the migration matched`, () => {
      const matched = [...historicalBodies(file)].filter(([, text]) => codes.includes(codeDigest(text) ?? ''));
      expect(matched.length).toBeGreaterThan(0);

      for (const [digest] of matched) {
        expect(SHIPPED_TEMPLATE_DIGESTS[file]).toContain(digest);
        const actions = planTemplateReconcile({
          bundled,
          shippedAnywhere: new Set(bundled.keys()),
          installed: new Map([[file, digest]]),
          ledger: {},
        });
        expect(actions.find(action => action.file === file)?.kind).toBe(expected);
      }
    });
  }
});
