// Every shipped .vkfilter, checked for the things that can be known without
// a VapourSynth core: that it parses, that the app will load it, and that its
// declarations and its code agree about what exists.
//
// A template failing any of these does not error — templateManager drops it
// with a log line and the filter simply never appears in the list, which is
// the kind of fault nobody notices until someone goes looking for a filter
// that used to be there.
//
// Whether the plugin a filter calls is installed, and whether its arguments
// still match that plugin, needs the real core. That is the opt-in suite in
// filterTemplates.integration.test.ts.

import { describe, it, expect } from 'vitest';
import * as TOML from '@iarna/toml';
import * as fs from 'fs';
import * as path from 'path';

const FILTER_DIR = path.resolve(__dirname, '..', 'include', 'plugins', 'plugin_filters');

interface Template {
  name?: unknown;
  code?: unknown;
  category?: unknown;
  description?: unknown;
  variables?: Record<string, { type?: string; default?: unknown; hidden?: boolean }>;
  editor?: { variables?: Record<string, unknown> };
}

const files = fs.readdirSync(FILTER_DIR).filter(f => f.endsWith('.vkfilter')).sort();

const parsed = files.map(file => ({
  file,
  raw: fs.readFileSync(path.join(FILTER_DIR, file), 'utf-8'),
}));

/** Both declaration forms the script generator substitutes. */
const DECLARATION = /\{\{\s*(?:stage\s*:\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** templateManager.getTemplatePath — the name is what decides the filename. */
const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9_\-\s]/g, '_');

/**
 * Filenames that do not match what their own `name` would be saved as.
 *
 * It matters because saveTemplate derives the path from the name, so editing
 * one of these in the app writes a second file rather than replacing the
 * first, and the filter list then shows the same name twice. Both of these
 * are also referenced by filename elsewhere — the plugin catalog names
 * "Undistort _Pytorch_.vkfilter" — so fixing them is a rename plus a catalog
 * edit plus a thought about installs that already have the old file, not a
 * one-line change.
 *
 * Listed rather than tolerated silently, and the list is checked for staleness
 * below so it shrinks when they are fixed and cannot quietly grow.
 */
const KNOWN_NAME_MISMATCHES = new Set([
  'DeHalo Alpha (Old).vkfilter',
  'Undistort _Pytorch_.vkfilter',
]);

function load(file: string, raw: string): Template {
  return TOML.parse(raw) as unknown as Template;
}

describe('shipped filter templates', () => {
  it('ships a catalog worth checking', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it.each(parsed)('$file is valid TOML', ({ file, raw }) => {
    expect(() => load(file, raw)).not.toThrow();
  });

  it.each(parsed)('$file carries what the loader requires', ({ file, raw }) => {
    const t = load(file, raw);
    // templateManager.loadTemplates keeps a template only if both are present.
    expect(typeof t.name, `${file}: name`).toBe('string');
    expect(String(t.name).trim(), `${file}: name`).not.toBe('');
    expect(typeof t.code, `${file}: code`).toBe('string');
    expect(String(t.code).trim(), `${file}: code`).not.toBe('');
  });

  it.each(parsed)('$file says what it is', ({ file, raw }) => {
    const t = load(file, raw);
    // Both are the filter list's only description of itself. A template with
    // neither is unfindable among a hundred and sixty others.
    expect(typeof t.description, `${file}: description`).toBe('string');
    expect(String(t.description).trim(), `${file}: description`).not.toBe('');
    expect(t.category, `${file}: category`).toBeDefined();
  });

  it.each(parsed)('$file is named as it would be saved', ({ file, raw }) => {
    const t = load(file, raw);
    const expected = `${sanitize(String(t.name))}.vkfilter`;
    if (KNOWN_NAME_MISMATCHES.has(file)) {
      expect(expected, `${file} is on the known-mismatch list but now agrees`)
        .not.toBe(file);
      return;
    }
    expect(expected, `${file}: name "${t.name}" would save as ${expected}`).toBe(file);
  });

  it('has no stale entries on the known-mismatch list', () => {
    // Each one must still exist, so the list cannot outlive the files it
    // excuses.
    for (const name of KNOWN_NAME_MISMATCHES) {
      expect(files, `${name} is excused but no longer shipped`).toContain(name);
    }
  });

  it.each(parsed)('$file declares every value it substitutes', ({ file, raw }) => {
    const t = load(file, raw);
    const declared = new Set(Object.keys(t.variables ?? {}));
    const used = [...String(t.code).matchAll(DECLARATION)].map(m => m[1]);

    for (const key of used) {
      // An undeclared {{key}} is left in the generated Python verbatim, which
      // reaches VapourSynth as a syntax error rather than as a missing value.
      expect(declared, `${file}: {{${key}}} is used but never declared`).toContain(key);
    }
  });

  it.each(parsed)('$file uses every value it declares', ({ file, raw }) => {
    const t = load(file, raw);
    const used = new Set([...String(t.code).matchAll(DECLARATION)].map(m => m[1]));
    // A variable can also be spent by an editor rather than by the code — the
    // LUT steps hold their table and lattice size that way.
    const byEditor = new Set(
      Object.values(t.editor?.variables ?? {}).flat().filter(v => typeof v === 'string') as string[],
    );

    for (const key of Object.keys(t.variables ?? {})) {
      const spent = used.has(key) || byEditor.has(key);
      // Otherwise it is a control offered to the user that changes nothing.
      expect(spent, `${file}: ${key} is declared but nothing reads it`).toBe(true);
    }
  });

  it.each(parsed)('$file gives every variable a usable default', ({ file, raw }) => {
    const t = load(file, raw);
    for (const [key, spec] of Object.entries(t.variables ?? {})) {
      // The default is what the generator substitutes until the user touches
      // the control, so a filter with none is broken on the way in.
      expect(spec?.default, `${file}: ${key} has no default`).toBeDefined();
      if (spec?.type) {
        expect(typeof spec.default, `${file}: ${key} is ${spec.type} but defaults to ${typeof spec.default}`)
          .toBe(spec.type);
      }
    }
  });

  it.each(parsed)('$file points its editor at variables that exist', ({ file, raw }) => {
    const t = load(file, raw);
    const declared = new Set(Object.keys(t.variables ?? {}));
    for (const ref of Object.values(t.editor?.variables ?? {}).flat()) {
      if (typeof ref !== 'string') continue;
      expect(declared, `${file}: editor names ${ref}, which is not declared`).toContain(ref);
    }
  });

  it('has no two templates claiming the same name', () => {
    const seen = new Map<string, string>();
    for (const { file, raw } of parsed) {
      const name = String(load(file, raw).name);
      // The filter list is keyed by name; a duplicate is one filter that can
      // never be picked.
      expect(seen.has(name), `${file} and ${seen.get(name)} are both "${name}"`).toBe(false);
      seen.set(name, file);
    }
  });
});
