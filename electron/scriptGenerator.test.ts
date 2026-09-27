import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as TOML from '@iarna/toml';
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

async function generate(
  filters: Filter[],
  generatePreviewOutputs = true,
  defaultBackend?: string,
  numStreams?: number,
  platform: NodeJS.Platform = 'win32',
): Promise<string> {
  const generator = new VapourSynthScriptGenerator(platform);
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

describe('the preview flag filter code reads', () => {
  it('is declared in a preview script and nowhere else', async () => {
    // A Load LUT step with no table yet passes the picture through in the
    // preview, because the table is measured from the frames on either side of
    // it in that very session — a step that refused to open until the table
    // existed would make the table impossible to make. That behaviour hangs
    // entirely off this one line being emitted, and a flag the filter reads
    // but nothing writes fails silently: the deadlock simply comes back.
    const preview = await generate([aiFilter(0, 'C:\\models\\2x_TestModel_fp16.onnx')], true);
    expect(preview).toContain('VK_PREVIEW = True');

    const render = await generate([aiFilter(0, 'C:\\models\\2x_TestModel_fp16.onnx')], false);
    expect(render).not.toContain('VK_PREVIEW');
  });

  it('is declared before the filter chain that reads it', async () => {
    const preview = await generate([aiFilter(0, 'C:\\models\\2x_TestModel_fp16.onnx')], true);
    expect(preview.indexOf('VK_PREVIEW = True')).toBeLessThan(preview.indexOf('_vk_set_output'));
  });
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

  it('uses POSIX basename semantics for Linux model paths', async () => {
    const script = await generate(
      [aiFilter(0, '/models/2x_TestModel_fp16.onnx')],
      true,
      undefined,
      undefined,
      'linux',
    );

    expect(script).toContain('_vk_set_output(clip, 1, "1. 2x_TestModel_fp16")');
    expect(script).not.toContain('_vk_set_output(clip, 1, "1. /models/2x_TestModel_fp16")');
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

describe('declared vkfilter variables', () => {
  it('renders the bundled NR working scale using the default or saved control value', async () => {
    const template = TOML.parse(await fs.readFile(
      path.join(process.cwd(), 'include/plugins/plugin_filters/DLSS Neural Uplift.vkfilter'), 'utf8',
    )) as unknown as { name: string; code: string; variables: Filter['variables'] };
    const filter = customFilter(0, template.name, template.code);
    filter.variables = template.variables;
    for (const scale of [undefined, 0.75, 0.5]) {
      filter.parameters = scale === undefined ? undefined : { working_scale: scale };
      const script = await generate([filter], false);
      expect(script).toContain(`working_scale   = ${scale ?? 1}`);
      expect(script).not.toContain('{{working_scale}}');
      expect(script).not.toMatch(/\{\{(?:style|style_strength|intensity|local_structure|skin_structure|auto_mask|auto_motion)\}\}/);
      expect(script).toContain('core.dlssnr.Enhance(');
    }
    filter.parameters = { style: 2, style_strength: 0.6, intensity: 0.7,
      local_structure: 0.8, skin_structure: 0.4, auto_mask: false, auto_motion: false };
    const configured = await generate([filter], false);
    for (const [key, value] of Object.entries(filter.parameters)) {
      expect(configured).toMatch(new RegExp(`${key}\\s*=\\s*${value === false ? 'False' : value}`));
    }
  });

  it('renders declared placeholders with persisted filter values', async () => {
    const filter = customFilter(
      0,
      'Crop',
      'left = {{crop_left}}\nright = {{crop_right}}\nlabel = {{label}}\nunknown = {{not_declared}}',
    );
    filter.variables = {
      crop_left: { type: 'number', default: 0 },
      crop_right: { type: 'number', default: 0 },
      label: { type: 'string', default: 'default' },
    };
    filter.parameters = { crop_left: 48, crop_right: 64, label: 'preview' };

    const script = await generate([filter], false);

    expect(script).toContain('left = 48');
    expect(script).toContain('right = 64');
    expect(script).toContain('label = "preview"');
    expect(script).toContain('unknown = {{not_declared}}');
  });

  it('uses a declared variable default when a filter has no saved value', async () => {
    const filter = customFilter(0, 'Crop', 'top = {{crop_top}}');
    filter.variables = { crop_top: { type: 'number', default: 12 } };

    const script = await generate([filter], false);

    expect(script).toContain('top = 12');
  });
});

describe('inference backend selection', () => {
  it('emits TensorRT code for the Windows default backend', async () => {
    const script = await generate([aiFilter(0, 'C:\\models\\m_fp16.engine')], false);

    expect(script).toContain('core.trt.Model(clip, engine_path="C:/models/m_fp16.engine"');
    expect(script).not.toContain('core.ort.Model');
  });

  it('retries a TensorRT engine whose I/O is the other float format (#12)', async () => {
    const script = await generate([aiFilter(0, 'C:\\models\\m_fp16.engine')], false);

    // The retry converts to the other float format and calls the same engine.
    expect(script).toContain("if 'bits per sample mismatch' not in str(_vk_trt_error):");
    expect(script).toContain('_vk_trt_fmt = vs.RGBS if _vk_trt_in[0].format.bits_per_sample == 16 else vs.RGBH');
    expect(script.match(/core\.trt\.Model\(/g)).toHaveLength(2);
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
    const generator = new VapourSynthScriptGenerator('win32');
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
    expect(script).toContain('def vk_backend(backend="auto", **kwargs):');
    expect(script).toContain('backend = VK_BACKEND if backend == "auto" else backend.lower()');
    expect(script).toContain('[backend](**kwargs)');
    expect(script).toContain('"tensorrt": Backend.TRT');
    expect(script).toContain('"directml": Backend.ORT_DML');
    expect(script).toContain('"ncnn": Backend.NCNN_VK');
    expect(script.indexOf('def vk_backend(')).toBeLessThan(script.indexOf('# Custom Filter: CAS Sharpen'));
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
    expect(script).toMatch(/VK_BUILD_ENV = \{.*"SystemRoot".*"COMSPEC".*\}/);
  });

  it('normalizes Windows-only backends to NCNN when generating a Linux script', async () => {
    const script = await generate(
      [aiFilter(0, 'C:\\models\\m_fp16.onnx', 'directml')],
      false,
      'directml',
      undefined,
      'linux',
    );

    expect(script).toContain('VK_BACKEND = "ncnn"');
    expect(script).toContain('core.ncnn.Model(clip, network_path="C:/models/m_fp16.onnx"');
    expect(script).not.toContain('provider="DML"');
  });

  it('does not emit Windows cmd.exe environment variables for Linux TensorRT scripts', async () => {
    const script = await generate(
      [customFilter(0, 'CAS Sharpen')],
      false,
      'tensorrt',
      undefined,
      'linux',
    );

    expect(script).toContain('VK_BACKEND = "tensorrt"');
    expect(script).toContain('VK_BUILD_ENV = {}');
    expect(script).not.toContain('"COMSPEC"');
  });
});

describe('a step that reads the picture from another step', () => {
  const reader = (order: number, sourceId: string, preset = 'Wavelet Color Fix from Step'): Filter => {
    const filter = customFilter(order, preset, 'reference = {{stage:source_id}}\nclip = fix(clip, reference)');
    filter.id = `reader-${order}`;
    filter.variables = { source_id: { type: 'string', default: '' } };
    filter.parameters = { source_id: sourceId };
    return filter;
  };

  it('keeps the named step and reads it back out of the same dict', async () => {
    const script = await generate([
      customFilter(0, 'CAS Sharpen'),
      aiFilter(1, 'C:\\models\\4x-AnimeSharp.engine'),
      reader(2, 'custom-0'),
    ], false);

    expect(script).toContain('VK_STAGES["custom-0"] = clip');
    expect(script).toContain('reference = VK_STAGES["custom-0"]');
    expect(script.indexOf('VK_STAGES["custom-0"] = clip'))
      .toBeLessThan(script.indexOf('reference = VK_STAGES["custom-0"]'));
  });

  it('keeps only the steps somebody named', async () => {
    const script = await generate([
      customFilter(0, 'CAS Sharpen'),
      aiFilter(1, 'C:\\models\\4x-AnimeSharp.engine'),
      reader(2, 'ai-1'),
    ], false);

    expect(script).toContain('VK_STAGES["ai-1"] = clip');
    expect(script).not.toContain('VK_STAGES["custom-0"]');
  });

  it('emits nothing about stages when no step names one', async () => {
    const script = await generate([customFilter(0, 'CAS Sharpen')], false);

    expect(script).not.toContain('VK_STAGES');
    expect(script).not.toContain('vk_stage_missing');
  });

  it('reads the source when nothing is named, which is what the old one always did', async () => {
    const script = await generate([customFilter(0, 'CAS Sharpen'), reader(1, '')], false);

    expect(script).toContain('reference = original_clip');
    expect(script).not.toContain('VK_STAGES');
  });

  it('says so by name when the named step is gone', async () => {
    const script = await generate([customFilter(0, 'CAS Sharpen'), reader(1, 'deleted-step')], false);

    expect(script).toContain(
      'vk_stage_missing("Wavelet Color Fix from Step reads the picture from a step that is no longer in the chain.")',
    );
    expect(script).toContain('def vk_stage_missing(message):');
  });

  it('says so by name when the named step is turned off', async () => {
    const off = customFilter(0, 'CAS Sharpen');
    off.enabled = false;
    const script = await generate([off, reader(1, 'custom-0')], false);

    expect(script).toContain(
      'vk_stage_missing("Wavelet Color Fix from Step reads the picture from step 1, CAS Sharpen, which is turned off.")',
    );
  });

  it('says so by name when the named step is below the one reading it', async () => {
    const script = await generate([reader(0, 'custom-1'), customFilter(1, 'CAS Sharpen')], false);

    expect(script).toContain('which comes after it');
    expect(script).toContain('step 2, CAS Sharpen');
  });

  it('refuses a step naming itself', async () => {
    const script = await generate([reader(0, 'reader-0')], false);

    expect(script).toContain(
      'vk_stage_missing("Wavelet Color Fix from Step reads the picture from itself.")',
    );
  });

  it('refuses a step that sits in the chain but produces no picture', async () => {
    // An AI step with no model chosen, and a custom step with an empty body,
    // both emit no code at all. Neither is in the dict, so a reference to one
    // has to be answered here rather than as a KeyError with no name on it.
    const modelless: Filter = { ...aiFilter(0, ''), modelPath: undefined };
    const script = await generate([modelless, reader(1, 'ai-0')], false);

    expect(script).toContain('step 1, AI Model, which produces no picture of its own');
  });

  it('keeps a stage for the render as well as the preview', async () => {
    const chain = [customFilter(0, 'CAS Sharpen'), reader(1, 'custom-0')];

    expect(await generate(chain, true)).toContain('VK_STAGES["custom-0"] = clip');
    expect(await generate(chain, false)).toContain('VK_STAGES["custom-0"] = clip');
  });

  it('takes the stage from after the trim, so both clips are the same length', async () => {
    const generator = new VapourSynthScriptGenerator('win32');
    const scriptPath = await generator.generateScript({
      inputVideo: 'C:\\videos\\input.mkv',
      enginePath: '',
      pluginsPath: 'C:\\plugins',
      filters: [customFilter(0, 'CAS Sharpen'), reader(1, 'custom-0')],
      segment: { enabled: true, startFrame: 100, endFrame: 200 },
    });
    const script = await fs.readFile(scriptPath, 'utf-8');
    await fs.remove(scriptPath);

    expect(script.indexOf('core.std.Trim(clip, first=100'))
      .toBeLessThan(script.indexOf('VK_STAGES["custom-0"] = clip'));
  });

  it('leaves an ordinary declared variable alone', async () => {
    const filter = reader(0, '');
    filter.code = 'reference = {{stage:source_id}}\nwho = {{source_id}}';
    const script = await generate([filter], false);

    expect(script).toContain('reference = original_clip');
    expect(script).toContain('who = ""');
  });
});

describe('the shipped filter that reads another step', () => {
  /** The real .vkfilter, because the placeholder in it is half of the contract. */
  const template = () => {
    const raw = fs.readFileSync(
      path.join(__dirname, '..', 'include', 'plugins', 'plugin_filters', 'Wavelet Color Fix from Step.vkfilter'),
      'utf-8',
    );
    return TOML.parse(raw) as unknown as {
      name: string;
      code: string;
      variables: Filter['variables'];
      editor: { variables: { source: string } };
    };
  };

  const step = (order: number, sourceId: string): Filter => {
    const tpl = template();
    return {
      id: `fix-${order}`,
      enabled: true,
      filterType: 'custom',
      preset: tpl.name,
      code: tpl.code,
      order,
      variables: tpl.variables,
      parameters: { [tpl.editor.variables.source]: sourceId },
    };
  };

  it('hands vs_colorfix the named step rather than original_clip', async () => {
    const script = await generate([customFilter(0, 'CAS Sharpen'), step(1, 'custom-0')], false);

    expect(script).toContain('reference    = VK_STAGES["custom-0"]');
    expect(script).toContain('vs_colorfix.wavelet(clip_float, reference_float');
  });

  it('leaves the older filter of the same name reading original_clip', async () => {
    // The whole point of a second filter is that the first one still works the
    // way it always did, off a name bound at the top of the template.
    const original = customFilter(0, 'Wavelet Color Fix', 'x = vs_colorfix.wavelet(clip, original_clip)');
    const script = await generate([original, step(1, '')], false);

    expect(script).toContain('vs_colorfix.wavelet(clip, original_clip)');
    expect(script).toContain('reference    = original_clip');
  });

  it('renders no leftover placeholder in either mode', async () => {
    for (const preview of [true, false]) {
      const script = await generate([customFilter(0, 'CAS Sharpen'), step(1, 'custom-0')], preview);
      expect(script).not.toContain('{{');
    }
  });
});
