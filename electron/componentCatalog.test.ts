import { describe, expect, it } from 'vitest';
import { catalogSchema, componentEntrySchema } from './componentCatalog';
import { readFileSync } from 'fs';
import { resolve } from 'path';
const catalog = JSON.parse(readFileSync(resolve(__dirname, '../include/component-catalog.json'), 'utf8'));
describe('curated component catalog', () => {
  it('ships only explicit, hashed experimental candidates while GPU validation is pending', () => {
    const parsed = catalogSchema.parse(catalog);
    expect(parsed.components).toHaveLength(2);
    for (const entry of parsed.components) {
      expect(entry.channel).toBe('experimental'); expect(entry.model?.spatialMultiple).toBe(2);
      expect(entry.files[0].url).toMatch(/\/[a-f0-9]{40}\//);
    }
  });
  it('rejects path traversal, mismatched model files, duplicate destinations and unapproved sources', () => {
    const entry = catalog.components[0];
    for (const path of ['../weights', '/tmp/model', 'C:\\model', 'weights/../model']) {
      expect(componentEntrySchema.safeParse({ ...entry, files: [{ ...entry.files[0], path }] }).success).toBe(false);
    }
    expect(componentEntrySchema.safeParse({ ...entry, files: [{ ...entry.files[0], url: 'https://example.org/model' }] }).success).toBe(false);
    expect(componentEntrySchema.safeParse({ ...entry, files: [entry.files[0], entry.files[0]] }).success).toBe(false);
    expect(componentEntrySchema.safeParse({ ...entry, model: { ...entry.model, file: 'other.onnx' } }).success).toBe(false);
  });
  it('rejects partial FFmpeg and unsupported relocatable Linux runtime bundles', () => {
    const entry = catalog.components[0];
    expect(componentEntrySchema.safeParse({ ...entry, kind: 'ffmpeg' }).success).toBe(false);
    expect(componentEntrySchema.safeParse({ ...entry, kind: 'runtime', runtime: { python: 'bin/python', packages: {}, vapoursynthCore: 79 } }).success).toBe(false);
  });
});
