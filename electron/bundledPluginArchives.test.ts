import { describe, expect, it } from 'vitest';
import {
  shouldCopyBundledPluginFilterTemplates,
  shouldExtractBundledPluginArchives,
} from './bundledPluginArchives';

describe('shouldExtractBundledPluginArchives', () => {
  it('allows the legacy native plugin archive on Windows', () => {
    expect(shouldExtractBundledPluginArchives('win32')).toBe(true);
  });

  it.each(['linux', 'darwin', 'freebsd'] as NodeJS.Platform[])(
    'rejects the Windows-only native plugin archive on %s',
    (platform) => {
      expect(shouldExtractBundledPluginArchives(platform)).toBe(false);
    }
  );
});

describe('shouldCopyBundledPluginFilterTemplates', () => {
  it('copies the platform-neutral plugin-filter catalog on supported desktops', () => {
    expect(shouldCopyBundledPluginFilterTemplates('win32')).toBe(true);
    expect(shouldCopyBundledPluginFilterTemplates('linux')).toBe(true);
    expect(shouldCopyBundledPluginFilterTemplates('darwin')).toBe(false);
  });
});
