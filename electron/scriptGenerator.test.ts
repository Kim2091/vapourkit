import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';

const testRoot = path.join(os.tmpdir(), `vk-scriptgen-test-${process.pid}`);

// The factory is hoisted above testRoot's initialization, so it must compute
// the same path itself rather than closing over the const
vi.mock('electron', async () => {
  const p = await import('path');
  const o = await import('os');
  const root = p.join(o.tmpdir(), `vk-scriptgen-test-${process.pid}`);
  return {
    app: {
      isPackaged: false,
      getAppPath: () => root,
      getPath: () => root,
    },
  };
});

vi.mock('./configManager', () => ({
  configManager: {
    isModelFp32: () => false,
    getModelType: () => 'image' as const,
    getTemporalFrames: () => undefined,
  },
}));

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { VapourSynthScriptGenerator, Filter } from './scriptGenerator';

const aiFilter = (order: number, modelPath: string): Filter => ({
  id: `ai-${order}`,
  enabled: true,
  filterType: 'aiModel',
  preset: 'AI Model',
  code: '',
  order,
  modelPath,
});

const customFilter = (order: number, preset: string, code = 'clip = core.std.BoxBlur(clip)'): Filter => ({
  id: `custom-${order}`,
  enabled: true,
  filterType: 'custom',
  preset,
  code,
  order,
});

async function generate(filters: Filter[], generatePreviewOutputs = true): Promise<string> {
  const generator = new VapourSynthScriptGenerator();
  const scriptPath = await generator.generateScript({
    inputVideo: 'C:\\videos\\input.mkv',
    enginePath: '',
    pluginsPath: 'C:\\plugins',
    filters,
    generatePreviewOutputs,
  });
  const content = await fs.readFile(scriptPath, 'utf-8');
  await fs.remove(scriptPath);
  return content;
}

beforeAll(async () => {
  // generateScript reads the template from <appData>/config/; stage the real
  // bundled template there so tests exercise the actual placeholder layout
  const templateSrc = path.join(__dirname, '..', 'include', 'vapoursynth_template.vpy');
  const configDir = path.join(testRoot, 'data', 'config');
  await fs.ensureDir(configDir);
  await fs.copy(templateSrc, path.join(configDir, 'vapoursynth_template.vpy'));
});

afterAll(async () => {
  await fs.remove(testRoot);
});

describe('generateScript preview outputs (vs-view)', () => {
  it('registers the source clip as output 0 even with a single stage', async () => {
    const script = await generate([aiFilter(0, 'C:\\models\\2x_TestModel_fp16.onnx')]);

    expect(script).toContain('_vk_set_output(original_clip, 0, "Source")');
    expect(script).toContain('_vk_set_output(clip, 1, "1. 2x_TestModel_fp16")');
  });

  it('names each stage output and numbers them sequentially', async () => {
    const script = await generate([
      customFilter(0, 'CAS Sharpen'),
      aiFilter(1, 'C:\\models\\4x-AnimeSharp.engine'),
    ]);

    expect(script).toContain('_vk_set_output(original_clip, 0, "Source")');
    expect(script).toContain('_vk_set_output(clip, 1, "1. CAS Sharpen")');
    expect(script).toContain('_vk_set_output(clip, 2, "2. 4x-AnimeSharp")');
  });

  it('falls back to bare set_output when vsview is not importable', async () => {
    const script = await generate([customFilter(0, 'CAS Sharpen')]);

    expect(script).toContain('from vsview import set_output as _vk_set_output');
    expect(script).toContain('except ImportError:');
    expect(script).toContain('c.set_output(i)');
  });

  it('skips stages that emit no code (empty custom filter)', async () => {
    const script = await generate([
      customFilter(0, 'Empty Filter', '   '),
      customFilter(1, 'CAS Sharpen'),
    ]);

    expect(script).not.toContain('Empty Filter');
    expect(script).toContain('_vk_set_output(clip, 1, "1. CAS Sharpen")');
    expect(script).not.toContain('_vk_set_output(clip, 2,');
  });

  it('strips the template\'s final bare set_output in preview mode', async () => {
    const script = await generate([customFilter(0, 'CAS Sharpen')]);

    expect(script.trimEnd()).not.toMatch(/clip\.set_output\(\)$/);
  });

  it('keeps the final bare set_output and adds no preview outputs when disabled', async () => {
    const script = await generate([customFilter(0, 'CAS Sharpen')], false);

    expect(script).toContain('clip.set_output()');
    expect(script).not.toContain('_vk_set_output');
  });

  it('escapes quotes and backslashes in stage names', async () => {
    const script = await generate([customFilter(0, 'My "Special" Filter')]);

    expect(script).toContain('_vk_set_output(clip, 1, "1. My \\"Special\\" Filter")');
  });
});
