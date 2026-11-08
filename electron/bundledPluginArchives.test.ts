import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { retireDroppedPluginArchives, shouldExtractBundledPluginArchives } from './bundledPluginArchives';

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

describe('retireDroppedPluginArchives', () => {
  it('removes the files of archives no longer shipped and keeps the rest', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-retire-'));
    try {
      for (const file of ['old.dll', 'kept.dll', 'other.dll']) fs.writeFileSync(path.join(dir, file), file);
      const plugins = {
        'old.7z': { digest: 'a', appVersion: '2.1.0', files: ['old.dll', 'gone.dll'] },
        'kept.7z': { digest: 'b', appVersion: '2.1.0', files: ['kept.dll'] },
      };

      expect(await retireDroppedPluginArchives(plugins, dir, ['kept.7z'])).toEqual(['old.7z']);
      expect(Object.keys(plugins)).toEqual(['kept.7z']);
      expect(fs.readdirSync(dir).sort()).toEqual(['kept.dll', 'other.dll']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
