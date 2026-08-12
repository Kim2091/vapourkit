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

const aiFilter = (order: number, modelPath: string, backend?: Filter['backend'], numStreams?: number): Filter => ({
  id: `ai-${order}`,
  enabled: true,
  filterType: 'aiModel',
  preset: 'AI Model',
  code: '',
  order,
  modelPath,
  backend,
  numStreams,
});

const customFilter = (order: number, preset: string, code = 'clip = core.std.BoxBlur(clip)'): Filter => ({
  id: `custom-${order}`,
  enabled: true,
  filterType: 'custom',
  preset,
  code,
  order,
});

async function generate(filters: Filter[], generatePreviewOutputs = true, defaultBackend?: string, numStreams?: number): Promise<string> {
  const generator = new VapourSynthScriptGenerator();
  const scriptPath = await generator.generateScript({
    inputVideo: 'C:\\videos\\input.mkv',
    enginePath: '',
    pluginsPath: 'C:\\plugins',
    filters,
    generatePreviewOutputs,
    defaultBackend,
    numStreams,
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

describe('inference backend selection', () => {
  it('emits TensorRT code for the default backend', async () => {
    const script = await generate([aiFilter(0, 'C:\\models\\m_fp16.engine')], false);

    expect(script).toContain('core.trt.Model(clip, engine_path="C:/models/m_fp16.engine"');
    expect(script).not.toContain('core.ort.Model');
  });

  it('emits DirectML code when the default backend is directml', async () => {
    const script = await generate([aiFilter(0, 'C:\\models\\m_fp16.onnx')], false, 'directml');

    expect(script).toContain('core.ort.Model(clip, network_path="C:/models/m_fp16.onnx"');
    expect(script).toContain('provider="DML"');
    expect(script).not.toContain('core.trt.Model');
  });

  it('honors a per-filter backend override against the default', async () => {
    const script = await generate([
      aiFilter(0, 'C:\\models\\a_fp16.engine'),
      aiFilter(1, 'C:\\models\\b_fp16.onnx', 'directml'),
    ], false);

    expect(script).toContain('core.trt.Model(clip, engine_path="C:/models/a_fp16.engine"');
    expect(script).toContain('core.ort.Model(clip, network_path="C:/models/b_fp16.onnx"');
  });

  it('treats an auto per-filter backend as the default backend', async () => {
    const script = await generate([aiFilter(0, 'C:\\models\\m_fp16.onnx', 'auto')], false, 'directml');

    expect(script).toContain('core.ort.Model');
  });

  it('honors a per-filter num_streams override against the global value', async () => {
    const script = await generate(
      [aiFilter(0, 'C:\\models\\m_fp16.engine', undefined, 4)],
      false, 'tensorrt', 2,
    );

    expect(script).toContain('num_streams=4');
    expect(script).not.toContain('num_streams=2');
  });

  it('inherits the global num_streams when a filter has no override', async () => {
    const script = await generate(
      [aiFilter(0, 'C:\\models\\m_fp16.engine')],
      false, 'tensorrt', 3,
    );

    expect(script).toContain('num_streams=3');
  });

  it('applies per-filter num_streams independently per model', async () => {
    const script = await generate(
      [
        aiFilter(0, 'C:\\models\\a_fp16.engine', undefined, 1),
        aiFilter(1, 'C:\\models\\b_fp16.engine'),
      ],
      false, 'tensorrt', 2,
    );

    expect(script).toContain('num_streams=1');
    expect(script).toContain('num_streams=2');
  });

  it('maps legacy useDirectML booleans to backend ids', async () => {
    const generator = new VapourSynthScriptGenerator();
    const scriptPath = await generator.generateScript({
      inputVideo: 'C:\\videos\\input.mkv',
      enginePath: '',
      pluginsPath: 'C:\\plugins',
      filters: [aiFilter(0, 'C:\\models\\m_fp16.onnx')],
      defaultBackend: true as any,
    });
    const script = await fs.readFile(scriptPath, 'utf-8');
    await fs.remove(scriptPath);

    expect(script).toContain('core.ort.Model');
  });

  it('injects the vk_backend helper with the selected default', async () => {
    const script = await generate([customFilter(0, 'CAS Sharpen')], false, 'directml');

    expect(script).toContain('VK_BACKEND = "directml"');
    expect(script).toContain('def vk_backend(');
    expect(script).toContain('"tensorrt": Backend.TRT');
    expect(script).toContain('"directml": Backend.ORT_DML');
    expect(script).toContain('"ncnn": Backend.NCNN_VK');
  });

  it('points vsmlrt at the app-managed model zoo and the trtexec shim', async () => {
    const script = await generate([customFilter(0, 'CAS Sharpen')], false);

    expect(script).toContain('import vsmlrt as _vk_vsmlrt');
    expect(script).toMatch(/_vk_vsmlrt\.models_path = ".*vsmlrt-models"/);
    // pip TensorRT ships no trtexec; vsmlrt's runtime engine builds go through
    // the app's shim so Backend.TRT works for script filters
    expect(script).toMatch(/_vk_vsmlrt\.trtexec_path = ".*trtexec(\.cmd)?"/);
    // Guarded so scripts still run when no vs-mlrt plugin is installed
    expect(script).toContain('except Exception:');
  });

  it('seeds the TensorRT backend env vsmlrt strips before spawning the shim', async () => {
    const script = await generate([customFilter(0, 'CAS Sharpen')], false);

    expect(script).toContain('backend.custom_env.setdefault(_key, _value)');
    if (process.platform === 'win32') {
      expect(script).toMatch(/VK_BUILD_ENV = \{.*"SystemRoot".*"COMSPEC".*\}/);
    }
  });
});
