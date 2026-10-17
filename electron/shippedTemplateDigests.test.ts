import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { RELEASE_TEMPLATE_DIGESTS, SHIPPED_TEMPLATE_DIGESTS } from './shippedTemplateDigests';
import { shippedTemplateDigest } from './shippedTemplateDigest';

const repoRoot = path.resolve(__dirname, '..');
const templateDirectories = ['include/filter_templates', 'include/plugins/plugin_filters'];

describe('shipped template digests', () => {
  // Launch replaces an installed template only when it matches a body in the
  // table. A bundled body missing from it is stranded in every install that
  // seeded it, from the release after this one onwards.
  it('covers every bundled template body', () => {
    const missing: string[] = [];
    for (const dir of templateDirectories) {
      for (const file of fs.readdirSync(path.join(repoRoot, dir)).filter(f => f.endsWith('.vkfilter'))) {
        const digest = shippedTemplateDigest(fs.readFileSync(path.join(repoRoot, dir, file)));
        if (!SHIPPED_TEMPLATE_DIGESTS[file]?.includes(digest)) missing.push(file);
      }
    }
    expect(missing, 'run: npx tsx scripts/generateShippedTemplateDigests.ts').toEqual([]);
  });

  it("resolves every release body to one of that template's shipped bodies", () => {
    const unresolved = Object.entries(RELEASE_TEMPLATE_DIGESTS).flatMap(([version, files]) =>
      Object.entries(files)
        .filter(([file, digest]) => typeof digest !== 'string' || !SHIPPED_TEMPLATE_DIGESTS[file]?.includes(digest))
        .map(([file]) => `${version} ${file}`));
    expect(Object.keys(RELEASE_TEMPLATE_DIGESTS).length).toBeGreaterThan(0);
    expect(unresolved).toEqual([]);
  });

  it('ignores line endings, so a CRLF checkout matches the LF body git stored', () => {
    expect(shippedTemplateDigest('name = "A"\r\ncode = """x"""\r\n'))
      .toBe(shippedTemplateDigest('name = "A"\ncode = """x"""\n'));
  });
});
