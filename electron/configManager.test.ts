import * as fs from 'fs-extra';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { dir } = vi.hoisted(() => {
  const nodePath = require('path') as typeof import('path');
  const nodeOs = require('os') as typeof import('os');
  return { dir: nodePath.join(nodeOs.tmpdir(), `vk-config-test-${process.pid}`) };
});

vi.mock('./constants', () => ({ PATHS: { CONFIG: dir } }));
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
// No bundled stock config, so loading does not migrate (and write) anything.
vi.mock('./utils', () => ({ getBundledBasePath: () => path.join(dir, 'no-bundle') }));
vi.mock('./rocmEnvironment', () => ({ DEFAULT_ROCM_SETTING: 'auto', setRocmSetting: vi.fn() }));

import { ConfigManager } from './configManager';

const configFile = path.join(dir, 'app-config.json');

describe('config file', () => {
  beforeEach(async () => { await fs.remove(dir); await fs.ensureDir(dir); });
  afterEach(async () => { await fs.remove(dir); });

  it('stays valid JSON with the last values when setters save at once', async () => {
    // Selecting a queue item sets five settings in a row, each saving the
    // whole file; overlapping plain writes used to leave invalid JSON.
    await fs.writeJson(configFile, { models: { mine: { useFp32: true, modelType: 'image', createdAt: 'x' } } });
    const manager = new ConfigManager();
    await manager.load();
    for (let round = 0; round < 10; round++) {
      await Promise.all([
        manager.setFfmpegArgs(round % 2 ? '-c:v libx265 -crf 16 -preset slower -x265-params a=b' : '-W'),
        manager.setProcessingFormat(round % 2 ? 'vs.YUV420P10' : 'vs.YUV420P8'),
        manager.setVideoCompareArgs(round % 2 ? '' : '-W -m'),
        manager.setOutputFormat(round % 2 ? 'mp4' : 'mkv'),
        manager.setShowQueue(round % 2 === 0),
      ]);
      const saved = await fs.readJson(configFile);
      expect(saved.processingFormat).toBe(round % 2 ? 'vs.YUV420P10' : 'vs.YUV420P8');
      expect(saved.showQueue).toBe(round % 2 === 0);
      expect(saved.models.mine.useFp32).toBe(true);
    }
  });

  it('moves an unreadable config aside before starting from defaults', async () => {
    await fs.writeFile(configFile, '{"models": {"mine": {"useFp32": true}}}}');
    const manager = new ConfigManager();
    await manager.load();
    expect(manager.getFfmpegArgs()).toContain('libx264');
    await manager.setShowQueue(true);

    const kept = (await fs.readdir(dir)).filter(name => name.startsWith('app-config.unreadable-'));
    expect(kept).toHaveLength(1);
    expect(await fs.readFile(path.join(dir, kept[0]), 'utf8')).toContain('"mine"');
    expect((await fs.readJson(configFile)).showQueue).toBe(true);
  });

  it('does not let one manager mutate the defaults another starts from', async () => {
    const first = new ConfigManager();
    await first.load();
    await first.setModelMetadata('leaked', false);
    const second = new ConfigManager();
    expect(second.getModelMetadata('leaked')).toBeNull();
  });
});
