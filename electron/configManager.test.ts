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

import { ConfigManager, DEFAULT_FFMPEG_ARGS } from './configManager';
import { DEFAULT_ENCODING, resolveEncodingArgs } from './encodingSettings';

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
        manager.setEncodingSettings(round % 2
          ? { ...DEFAULT_ENCODING, mode: 'advanced', customArgs: '-c:v libx265 -crf 16 -preset slower -x265-params a=b' }
          : DEFAULT_ENCODING),
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

describe('encoding settings', () => {
  beforeEach(async () => { await fs.remove(dir); await fs.ensureDir(dir); });
  afterEach(async () => { await fs.remove(dir); });

  const STOCK_ARGS = DEFAULT_FFMPEG_ARGS + ' -movflags +faststart';

  it('opens a config holding only the old stock arguments in simple mode', async () => {
    await fs.writeJson(configFile, { ffmpegArgs: STOCK_ARGS, models: {} });
    const manager = new ConfigManager();
    await manager.load();
    expect(manager.getEncodingSettings().mode).toBe('simple');
    expect(manager.getEncodingSettings().simple).toEqual({ codec: 'h264', encoder: 'software', preset: 'medium', quality: 18 });
    expect(manager.getFfmpegArgs()).toBe(DEFAULT_FFMPEG_ARGS);
  });

  it('keeps hand-typed arguments as they are, in advanced mode', async () => {
    const typed = '-c:v hevc_nvenc -preset p5 -cq 22 -b:v 0 -tune hq';
    await fs.writeJson(configFile, { ffmpegArgs: typed, models: {} });
    const manager = new ConfigManager();
    await manager.load();
    expect(manager.getEncodingSettings()).toMatchObject({ mode: 'advanced', customArgs: typed });
    expect(manager.getEncodingSettings().simple).toMatchObject({ codec: 'h265', encoder: 'nvidia', preset: 'p5', quality: 22 });
    expect(manager.getFfmpegArgs()).toBe(typed);
  });

  it('saves the mode with the arguments it resolves to, and reads it back', async () => {
    const manager = new ConfigManager();
    await manager.load();
    const encoding = { ...DEFAULT_ENCODING, mode: 'advanced' as const, customArgs: '-c:v libx264 -crf 18' };
    expect(await manager.setEncodingSettings(encoding)).toBe(true);
    const saved = await fs.readJson(configFile);
    expect(saved.encoding).toEqual(encoding);
    expect(saved.ffmpegArgs).toBe('-c:v libx264 -crf 18');

    const reloaded = new ConfigManager();
    await reloaded.load();
    // These arguments parse as simple settings, and stay advanced all the same.
    expect(reloaded.getEncodingSettings()).toEqual(encoding);
    expect(reloaded.getFfmpegArgs()).toBe('-c:v libx264 -crf 18');
  });

  it('follows arguments an older version changed', async () => {
    const encoding = { ...DEFAULT_ENCODING, mode: 'advanced' as const, customArgs: '-c:v libx264 -tune film' };
    await fs.writeJson(configFile, { encoding, ffmpegArgs: '-c:v libx265 -preset slow -crf 20', models: {} });
    const manager = new ConfigManager();
    await manager.load();
    expect(manager.getEncodingSettings()).toEqual({
      mode: 'simple',
      simple: { codec: 'h265', encoder: 'software', preset: 'slow', quality: 20 },
      customArgs: '-c:v libx264 -tune film',
    });
  });

  it('refuses settings that are not encoding settings', async () => {
    const manager = new ConfigManager();
    await manager.load();
    expect(await manager.setEncodingSettings('-c:v libx264')).toBe(false);
    expect(manager.getFfmpegArgs()).toBe(resolveEncodingArgs(DEFAULT_ENCODING));
  });
});
