// electron/scriptGenerator.ts
import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import { PATHS } from './constants';
import { getSystemRoot } from './trtexecShim';
import { app } from 'electron';
import { fixAsarPath } from './utils';
import { configManager } from './configManager';
import { logger } from './logger';
import { BACKENDS, normalizeBackendForPlatform, resolveFilterBackend, type BackendId, type FilterBackend } from './providers/descriptors';
import { getProvider } from './providers/registry';
import type { InferenceProvider } from './providers/types';
import { parseReferenceVideo } from './referenceVideo';
import { timecodesPathFor } from './sourceTiming';
import {
  layoutChains,
  resolveReference,
  SIDE_CHAIN_OUTPUT_BASE,
  sideChainLabel,
  sideChainLetter,
  sideChainRuns,
  stepTag,
  samePath,
  type Chain,
  type SideChainAlignment,
} from './chainGraph';

export type ModelType = 'vsr' | 'image';

/** Renders a JS string as a Python string literal. */
function pyString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * One step naming another step's picture: `{{stage:source_id}}`, where
 * `source_id` is a variable of that filter holding the target step's id.
 *
 * Until now a filter could reach outside its own input in exactly one way —
 * the name `original_clip`, bound once near the top of the script — and moving
 * that binding took a step of its own whose entire job was `original_clip =
 * clip`. One name, one binding, and a marker in the list to move it.
 *
 * The reference is an id and not a position because a position is a claim that
 * stops being true the moment anything above it moves. An id either names a
 * step in the chain or it does not, and every way it can stop naming one is
 * answered below by a message rather than by a KeyError.
 */
const STAGE_REFERENCE = /\{\{\s*stage\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** The dict a referenced step's picture is written into, as the script runs. */
const STAGES = 'VK_STAGES';

/** The shared runtime every generated script imports (include/, copied to data/config/). */
const RUNTIME_FILE = 'vk_runtime.py';

/** The helpers a generated script imports from it. */
const RUNTIME_HELPERS = [
  'vk_backend', 'vk_migx_model', 'vk_paired_by_time', 'vk_reference_video',
  'vk_open_video', 'vk_conform', 'vk_stage_missing', 'vk_interpolated_timing',
  'vk_timed_output',
];


export interface Filter {
  id: string;
  enabled: boolean;
  /** 'videoSource' is a Load Video step, which heads a side chain (chainGraph.ts). */
  filterType: 'aiModel' | 'custom' | 'videoSource';
  preset: string;
  code: string;
  order: number;
  /** A Load Video step's file. */
  sourcePath?: string;
  /** A Load Video's measured timing against the main source. */
  align?: SideChainAlignment;
  /** The Load Video step whose side chain this step is in; absent for the main chain. */
  chain?: string;
  modelPath?: string;
  modelType?: 'vsr' | 'image';
  /** Inference backend override for this filter; 'auto' or unset inherits the app default. */
  backend?: FilterBackend;
  /** num_streams override for this AI model; unset inherits config.numStreams. */
  numStreams?: number;
  /** Values supplied to declared {{variable}} placeholders in custom code. */
  parameters?: Record<string, string | number | boolean>;
  /** Declarations limit which placeholders can be rendered. */
  variables?: Record<string, {
    type?: 'number' | 'string' | 'boolean';
    default?: string | number | boolean;
    description?: string;
    /** App-written: substituted into the code, never offered as a control. */
    hidden?: boolean;
  }>;
}

export interface SegmentSelection {
  enabled: boolean;
  startFrame: number;
  endFrame: number; // -1 means end of video
}

export interface ScriptConfig {
  inputVideo: string;
  /** App-level default inference backend; per-filter overrides resolve against it. */
  defaultBackend?: string;
  colorimetry?: {
    overwriteMatrix: boolean;
    matrix709: boolean;
    defaultMatrix: '709' | '170m';
    defaultPrimaries: '709' | '601';
    defaultTransfer: '709' | '170m';
  };
  filters?: Filter[];
  numStreams?: number;
  outputFormat?: string;
  segment?: SegmentSelection;
  validationMode?: boolean; // If true, only process first 5 seconds for validation
  sourceFps?: number; // Source video FPS for validation frame calculation
  generatePreviewOutputs?: boolean; // If true, add output nodes after each filter for vs-view
}

export class VapourSynthScriptGenerator {
  /**
   * The target runtime platform. Production callers use the host platform;
   * accepting it here makes the platform policy testable without mutating
   * Node's read-only process.platform.
   */
  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  /**
   * Model paths are persisted by the target app, so parse them with that
   * platform's separator rules instead of the operating system running tests.
   */
  private basename(filePath: string): string {
    return (this.platform === 'win32' ? path.win32 : path.posix).basename(filePath);
  }

  private getTemplatePath(): string {
    const templateName = 'vapoursynth_template.vpy';
    const templatePath = path.join(PATHS.CONFIG, templateName);
    return templatePath;
  }

  /**
   * Replaces values explicitly declared by a .vkfilter's [variables] table.
   * Keeping this scoped to declarations means ordinary Python braces and
   * accidental template-like text remain untouched.
   *
   * Stage references go first and are not declarations in the same sense: the
   * declared variable holds a step id, and what lands in the Python is the
   * clip that step produced. They cannot collide with the plain form below,
   * which has no colon in it.
   */
  private renderCustomFilterCode(filter: Filter, stage: (variable: string) => string): string {
    const code = filter.code.trim().replace(STAGE_REFERENCE, (_match, key: string) => stage(key));
    if (!filter.variables) return code;

    return code.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (match, key: string) => {
      const declaration = filter.variables?.[key];
      if (!declaration) return match;

      const value = filter.parameters?.[key] ?? declaration.default;
      if (typeof value === 'number') return Number.isFinite(value) ? String(value) : match;
      if (typeof value === 'boolean') return value ? 'True' : 'False';
      if (typeof value === 'string') return pyString(value);
      return match;
    });
  }

  /** The step id a filter's stage reference names, or '' for the source. */
  private stageIdOf(filter: Filter, variable: string): string {
    const value = filter.parameters?.[variable] ?? filter.variables?.[variable]?.default;
    return typeof value === 'string' ? value.trim() : '';
  }

  /** Every step id some enabled filter names. Nothing else is worth keeping. */
  private referencedStageIds(enabledFilters: Filter[]): Set<string> {
    const wanted = new Set<string>();
    for (const filter of enabledFilters) {
      if (filter.filterType !== 'custom') continue;
      for (const [, variable] of filter.code.matchAll(STAGE_REFERENCE)) {
        const id = this.stageIdOf(filter, variable);
        if (id && !parseReferenceVideo(id)) wanted.add(id);
      }
    }
    return wanted;
  }

  /**
   * What one stage reference becomes in the emitted Python.
   *
   * `emitted` is the set of steps that have already written their picture into
   * VK_STAGES *in this script*, which is the only thing that makes a reference
   * safe — not "the target is enabled", not "the target is above". A step with
   * no model chosen and a custom step with an empty body both sit in the chain
   * and emit nothing, and a reference to either would otherwise be a KeyError
   * with no name attached to it.
   *
   * Everything that is not safe becomes a call that raises. The generator is
   * the only place that knows which of the four ways it went wrong, so it is
   * the only place that can say so.
   */
  private renderStageReference(
    filter: Filter,
    variable: string,
    emitted: Set<string>,
    allFilters: Filter[],
    first: number,
  ): string {
    const id = this.stageIdOf(filter, variable);
    const reference = resolveReference(allFilters, filter, id);
    const here = filter.preset || 'A custom filter';
    const missing = (why: string) => `vk_stage_missing(${pyString(`${here} reads the picture from ${why}.`)})`;
    const step = (target: Filter) => `step ${stepTag(allFilters, target.id)}, ${target.preset || 'a custom filter'}`;
    const chain = (target: Chain<Filter>) => {
      const at = layoutChains(allFilters).side.findIndex(candidate => candidate.id === target.id);
      return `side chain ${sideChainLetter(Math.max(at, 0))}, ${sideChainLabel(target)}`;
    };

    switch (reference.state) {
      case 'source':
        return 'original_clip';
      case 'file':
        return `vk_reference_video(${pyString(reference.video.path)}, ${reference.video.offset}, clip, ${first}, source=original_clip)`;
      case 'chain':
        // Its own timeline: lined up by time with the clip reading it.
        return emitted.has(id)
          ? `vk_paired_by_time(${STAGES}[${pyString(id)}], clip, ${first}, source=original_clip)`
          : missing(`${chain(reference.chain)}, which produced no picture`);
      case 'ready':
        // Emitted is the authority, not the resolution: a step that resolved
        // but wrote nothing is still nothing to read.
        return emitted.has(id)
          ? `${STAGES}[${pyString(id)}]`
          : missing(`${step(reference.step)}, which produces no picture of its own`);
      case 'chainOff':
        return missing(`${chain(reference.chain)}, which is turned off or has no video chosen`);
      case 'chainLoop':
        return missing(`${chain(reference.chain)}, which starts below its own side chain — a side chain can only read one above it`);
      case 'missing':
        return missing('a step that is no longer in the chain');
      case 'self':
        return missing('itself');
      case 'otherChain':
        return missing(`${step(reference.step)}, which is inside another chain — only a whole side chain can be read from outside it`);
      case 'disabled':
        return missing(`${step(reference.step)}, which is turned off`);
      case 'below':
        return missing(`${step(reference.step)}, which comes after it — a step can only read the picture from one above it`);
      case 'silent':
        return missing(`${step(reference.step)}, which produces no picture of its own`);
    }
  }

  /**
   * The script's head for the shared runtime (include/vk_runtime.py, copied
   * to data/config/): VK_BACKEND and VK_BUILD_ENV, which filter code reads,
   * the import of the helpers, and the configure() call that hands the
   * runtime this run's backend, the backend registry's id -> vsmlrt Backend
   * map, and the paths of the model zoo, trtexec shim and migraphx-driver.
   * Custom .vkfilter code calls vk_backend(...) to get a vsmlrt Backend that
   * follows the backend dropdown.
   */
  private generateBackendHelper(defaultBackend: BackendId): string {
    const backendAttrs = BACKENDS
      .map(d => `${pyString(d.id)}: ${pyString(d.vsmlrtBackendAttr)}`)
      .join(', ');
    const buildEnvEntries = Object.entries(this.getEngineBuildEnv())
      .map(([key, value]) => `${pyString(key)}: ${pyString(value)}`)
      .join(', ');
    const posix = (p: string) => pyString(p.replace(/\\/g, '/'));
    // On Linux the runtime picks the driver of the ROCm chosen in Settings.
    const migraphxDriver = this.platform === 'win32' ? posix(PATHS.MIGX_DRIVER_WIN) : 'None';

    let code = '# Inference backend selected in the app; vk_backend() resolves it to a\n';
    code += '# vsmlrt Backend for custom filters (kwargs pass through, e.g. fp16=True)\n';
    code += `VK_BACKEND = "${defaultBackend}"\n`;
    code += '# vsmlrt builds TensorRT engines at runtime by spawning trtexec with a nearly\n';
    code += '# empty environment; these are what the app\'s trtexec shim needs to start.\n';
    code += `VK_BUILD_ENV = {${buildEnvEntries}}\n`;
    code += '# Helpers every script shares (data/config/vk_runtime.py)\n';
    code += 'import sys as _vk_sys\n';
    code += `if ${posix(PATHS.CONFIG)} not in _vk_sys.path:\n`;
    code += `    _vk_sys.path.insert(0, ${posix(PATHS.CONFIG)})\n`;
    code += 'import vk_runtime\n';
    code += `from vk_runtime import ${RUNTIME_HELPERS.join(', ')}\n`;
    code += `vk_runtime.configure(VK_BACKEND, {${backendAttrs}}, VK_BUILD_ENV,\n`;
    code += `                     models_path=${posix(PATHS.VSMLRT_MODELS)},\n`;
    code += `                     trtexec_path=${posix(PATHS.TRTEXEC_SHIM)},\n`;
    code += `                     migraphx_driver_path=${migraphxDriver})\n\n`;
    return code;
  }

  /**
   * Environment seeded into vsmlrt's TensorRT backend (`custom_env`). vsmlrt
   * spawns the engine builder with `{"CUDA_MODULE_LOADING": "LAZY"}` and nothing
   * else, which on Windows is not enough for cmd.exe to launch the .cmd shim.
   */
  private getEngineBuildEnv(): Record<string, string> {
    if (this.platform !== 'win32') {
      return {};
    }
    const systemRoot = getSystemRoot();
    return {
      SystemRoot: systemRoot,
      COMSPEC: path.join(systemRoot, 'System32', 'cmd.exe'),
    };
  }

  /**
   * Makes data/config/vk_runtime.py match the bundled include/vk_runtime.py,
   * which every generated script imports. Checked on every generation so an
   * edit reaches a development run at once; the copy is written beside the
   * target and renamed over it, so a script starting meanwhile never reads
   * half a file.
   */
  private async syncRuntime(): Promise<void> {
    const target = path.join(PATHS.CONFIG, RUNTIME_FILE);
    const bundled = path.join(fixAsarPath(app.getAppPath()), 'include', RUNTIME_FILE);
    if (await fs.pathExists(bundled)) {
      const source = await fs.readFile(bundled, 'utf-8');
      const current = await fs.readFile(target, 'utf-8').catch(() => null);
      if (current === source) return;
      await fs.ensureDir(PATHS.CONFIG);
      const staged = `${target}.${process.pid}-${Math.random().toString(36).substring(2, 9)}.tmp`;
      await fs.writeFile(staged, source, 'utf-8');
      await fs.move(staged, target, { overwrite: true });
      logger.info(`Updated ${RUNTIME_FILE} from bundled source`);
    } else if (!await fs.pathExists(target)) {
      throw new Error(`${RUNTIME_FILE} is missing from ${PATHS.CONFIG}. Reinstall Vapourkit to restore it.`);
    }
  }

  async generateScript(config: ScriptConfig): Promise<string> {
    await this.syncRuntime();
    const templatePath = this.getTemplatePath();
    let template = await fs.readFile(templatePath, 'utf-8');

    // This main-process boundary protects against imported settings, workflows,
    // and queue items containing a backend unsupported by the current OS.
    const defaultBackend = normalizeBackendForPlatform(config.defaultBackend, this.platform);

    // Apply colorimetry settings
    const overwriteMatrix = config.colorimetry?.overwriteMatrix ? 'True' : 'False';
    const matrix709 = config.colorimetry?.matrix709 ? 'True' : 'False';
    const defaultMatrix = config.colorimetry?.defaultMatrix || '709';
    const defaultPrimaries = config.colorimetry?.defaultPrimaries || '709';
    const defaultTransfer = config.colorimetry?.defaultTransfer || '709';
    const outputFormat = config.outputFormat || 'vs.YUV420P8';

    // Process filters sequentially
    const filters = config.filters || [];
    // The list is linear; what runs is a graph (chainGraph.ts). Side chains
    // that run, each its own short list, then the main chain. Steps of a side
    // chain that does not run, and steps whose side chain is gone, run nowhere.
    const layout = layoutChains(filters);
    const sideChains = layout.side.filter(sideChainRuns);
    const enabledMain = layout.main.steps.filter(f => f.enabled);
    const enabledFilters = [...sideChains.flatMap(chain => chain.steps.filter(f => f.enabled)), ...enabledMain];
    // Where the main chain's segment starts, in its source's frames: what a
    // picture from another timeline is lined up against. Side chains are
    // never trimmed, so for them it is always 0.
    const mainFirst = !config.validationMode && config.segment?.enabled ? config.segment.startFrame : 0;

    const backendHelper = this.generateBackendHelper(defaultBackend);
    let filterCode = '';

    // An alignment is measured against one main video; against another (a
    // different file, a batch job) it says nothing, and the side chain is
    // paired by time like an unaligned one.
    const alignmentOf = (chain: Chain<Filter>) => {
      const align = chain.head?.align;
      return align && align.sections.length > 0 && samePath(align.alignedTo, config.inputVideo) ? align : undefined;
    };
    if (sideChains.some(alignmentOf)) {
      filterCode += '# The main source as loaded, before any trim: what an aligned side chain is put on\n';
      filterCode += 'vk_source = original_clip\n\n';
    }

    // Add validation mode trimming (first 5 seconds only)
    if (config.validationMode) {
      // Calculate frames for 5 seconds based on source FPS (default to 30 if unknown)
      const fps = config.sourceFps || 30;
      const validationFrames = Math.ceil(fps * 5);
      filterCode += '# Validation Mode - Only process first 5 seconds\n';
      filterCode += `clip = core.std.Trim(clip, first=0, last=${validationFrames - 1})\n`;
      filterCode += `original_clip = core.std.Trim(original_clip, first=0, last=${validationFrames - 1})\n\n`;
    }
    // Add segment trimming if enabled (and not in validation mode)
    else if (config.segment?.enabled) {
      const startFrame = config.segment.startFrame;
      const endFrame = config.segment.endFrame;

      filterCode += '# Segment Selection (Trim)\n';
      if (endFrame === -1) {
        // Trim from start to end
        filterCode += `clip = core.std.Trim(clip, first=${startFrame})\n`;
        filterCode += `original_clip = core.std.Trim(original_clip, first=${startFrame})\n\n`;
      } else {
        // Trim from start to specific end frame
        filterCode += `clip = core.std.Trim(clip, first=${startFrame}, last=${endFrame - 1})\n`;
        filterCode += `original_clip = core.std.Trim(original_clip, first=${startFrame}, last=${endFrame - 1})\n\n`;
      }
    }

    // For vs-view previews, name output tabs via vsview's set_output API and
    // always register the unprocessed (but trimmed) input as output 0, so a
    // single-stage workflow still has a "before" clip to compare against.
    if (config.generatePreviewOutputs) {
      // A flag the filter code can read, for the few steps that have to
      // behave differently while a look is still being built. A Load LUT
      // with no table is the case that matters: the table is measured from
      // the frames on either side of it in this very session, so a step that
      // refused to open until the table existed would make the table
      // impossible to make. A render has no such excuse and still stops.
      filterCode += 'VK_PREVIEW = True\n';
      filterCode += '# Preview outputs (named tabs in vs-view)\n';
      filterCode += 'try:\n';
      filterCode += '    from vsview import set_output as _vk_set_output\n';
      filterCode += 'except ImportError:\n';
      filterCode += '    def _vk_set_output(c, i, n=None):\n';
      filterCode += '        c.set_output(i)\n';
      filterCode += '_vk_set_output(original_clip, 0, "Source")\n\n';
    }

    // Only steps somebody names are kept. Every kept clip is a node the chain
    // above it has to be able to produce a second time, so a script that held
    // on to all of them would make every chain pay for a feature only some use.
    const wantedStages = this.referencedStageIds(enabledFilters);
    const emittedStages = new Set<string>();
    if (wantedStages.size > 0 || sideChains.length > 0) {
      filterCode += '# Pictures kept for a step below that reads them\n';
      filterCode += `${STAGES} = {}\n\n`;
    }

    let previewOutputIndex = 0;

    /** One step's code, and its picture kept when something names it. */
    const emitStep = (filter: Filter, first: number): string | null => {
      let stageLabel: string | null = null;

      if (filter.filterType === 'aiModel' && filter.modelPath) {
        // Generate AI model upscaling code with this filter's effective backend
        // Check precision and model type for THIS specific model from config, not filter state
        const filterBackend = normalizeBackendForPlatform(
          resolveFilterBackend(filter.backend, defaultBackend),
          this.platform,
        );
        const provider = getProvider(filterBackend);
        const filterUseFp32 = configManager.isModelFp32(filter.modelPath);
        const filterModelType = configManager.getModelType(filter.modelPath);
        const filterTemporalFrames = configManager.getTemporalFrames(filter.modelPath);
        filterCode += this.generateAIModelCode(filter, provider, filterUseFp32, filterModelType, defaultMatrix, defaultPrimaries, defaultTransfer, filter.numStreams ?? config.numStreams, filterTemporalFrames);
        stageLabel = this.basename(filter.modelPath).replace(/\.(onnx|engine)$/i, '');
      } else if (filter.filterType === 'custom' && filter.code.trim()) {
        // Insert custom filter code
        filterCode += '# Custom Filter: ' + (filter.preset || 'Unnamed') + '\n';
        filterCode += this.renderCustomFilterCode(
          filter,
          variable => this.renderStageReference(filter, variable, emittedStages, filters, first),
        ) + '\n\n';
        stageLabel = filter.preset || 'Custom Filter';
      }

      // Kept after the step's own code, so what is stored is what the step
      // produced. `emittedStages` is written here and nowhere else, which is
      // what lets a step further down resolve on having actually seen the line
      // rather than on a second opinion about whether it would be emitted.
      if (stageLabel !== null && wantedStages.has(filter.id)) {
        filterCode += `${STAGES}[${pyString(filter.id)}] = clip\n\n`;
        emittedStages.add(filter.id);
      }
      return stageLabel;
    };

    // Side chains run first, in the order their Load Videos sit, so anything
    // below can read them. Each borrows `clip` and `original_clip` for its own
    // video and hands both back, so a filter inside one — VIVTC rebinding
    // original_clip, a colour fix reading it — acts on the side chain's own
    // source without knowing it is in one. Its last picture is kept under the
    // Load Video's id, which is the id a step reading the chain stores.
    for (const chain of sideChains) {
      const head = chain.head!;
      filterCode += `# Side chain ${sideChainLetter(layout.side.indexOf(chain))}: ${sideChainLabel(chain)}\n`;
      filterCode += '_vk_main = (clip, original_clip)\n';
      filterCode += `clip = vk_open_video(${pyString(head.sourcePath!)}, globals())\n`;
      const align = alignmentOf(chain);
      if (align) {
        const sections = align.sections.map(sec => `(${sec.from}, ${sec.offset})`).join(', ');
        const framing = (align.framing ?? []).map(f => `(${f.from}, ${f.left}, ${f.top}, ${f.width}, ${f.height})`).join(', ');
        filterCode += framing
          ? `clip = vk_conform(clip, vk_source, ${align.speed}, [${sections}], [${framing}])\n`
          : `clip = vk_conform(clip, vk_source, ${align.speed}, [${sections}])\n`;
      }
      filterCode += 'original_clip = clip\n\n';
      for (const filter of chain.steps.filter(f => f.enabled)) emitStep(filter, 0);
      filterCode += `${STAGES}[${pyString(head.id)}] = clip\n`;
      filterCode += 'clip, original_clip = _vk_main\n\n';
      emittedStages.add(head.id);
    }

    for (const filter of enabledMain) {
      const stageLabel = emitStep(filter, mainFirst);
      // Register an output after each stage that actually emitted code
      if (config.generatePreviewOutputs && stageLabel !== null) {
        previewOutputIndex++;
        filterCode += `_vk_set_output(clip, ${previewOutputIndex}, ${pyString(`${previewOutputIndex}. ${stageLabel}`)})\n\n`;
      }
    }

    // One tab per side chain, its last picture, clear of the main chain's
    // numbering (SIDE_CHAIN_OUTPUT_BASE) so adding one renumbers nothing.
    if (config.generatePreviewOutputs) {
      sideChains.forEach((chain, at) => {
        const label = `${sideChainLetter(layout.side.indexOf(chain))}. ${sideChainLabel(chain)}`;
        filterCode += `_vk_set_output(${STAGES}[${pyString(chain.id)}], ${SIDE_CHAIN_OUTPUT_BASE + at}, ${pyString(label)})\n`;
      });
      if (sideChains.length > 0) filterCode += '\n';
    }

    // Use timestamp + random string for unique script path to avoid collisions in batch processing
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substring(2, 9);
    const tempScriptPath = path.join(os.tmpdir(), `VSR_upscale_${timestamp}_${randomId}.vpy`);

    // Replace all placeholders
    template = template
      .replace(/{{INPUT_VIDEO}}/g, config.inputVideo.replace(/\\/g, '/'))
      .replace(/{{SOURCE_TIMECODES}}/g, timecodesPathFor(tempScriptPath).replace(/\\/g, '/'))
      .replace(/{{OVERWRITE_MATRIX}}/g, overwriteMatrix)
      .replace(/{{MATRIX_709}}/g, matrix709)
      .replace(/{{DEFAULT_MATRIX}}/g, defaultMatrix)
      .replace(/{{DEFAULT_PRIMARIES}}/g, defaultPrimaries)
      .replace(/{{DEFAULT_TRANSFER}}/g, defaultTransfer)
      .replace(/{{OUTPUT_FORMAT}}/g, outputFormat)
      .replace(/{{BACKEND_HELPER}}/g, backendHelper)
      .replace(/{{FILTERS}}/g, filterCode);

    // Remove the final clip.set_output() call if we're generating preview outputs
    // since we want only the numbered outputs for vs-view
    if (config.generatePreviewOutputs) {
      template = template.replace(/clip\.set_output\(\)\s*$/, '');
    }

    await fs.writeFile(tempScriptPath, template, 'utf-8');

    logger.info(`Generated script: ${tempScriptPath}`);
    return tempScriptPath;
  }

  /**
   * Generate VapourSynth code for an AI model filter. The clip preparation
   * (RGB conversion, temporal frame shifting, YUV restore) is backend-agnostic;
   * the model invocation itself comes from the filter's inference provider.
   */
  private generateAIModelCode(filter: Filter, provider: InferenceProvider, useFp32: boolean, modelType: ModelType, defaultMatrix: string, defaultPrimaries: string, defaultTransfer: string, numStreams?: number, temporalFrames?: number): string {
    if (!filter.modelPath) return '';

    // Constant for the VapourSynth clip variable name
    const CLIP = 'clip';

    const modelFile = provider.resolveModelFile(filter.modelPath);

    let code = '# AI Model\n';

    // Add RGB conversion before model processing and clamp to 0-1 range
    // Use RGBS (float32) for fp32 models, RGBH (float16) for fp16 models
    const rgbFormat = useFp32 ? 'vs.RGBS' : 'vs.RGBH';
    code += '# Convert to RGB format for upscaling\n';
    code += `if ${CLIP}.format.id != ${rgbFormat}:\n`;
    code += `    ${CLIP} = core.resize.Bilinear(${CLIP}, format=${rgbFormat}, matrix_in_s="${defaultMatrix}", primaries_in_s="${defaultPrimaries}", transfer_in_s="${defaultTransfer}")\n`;
    code += `${CLIP} = core.std.Expr(${CLIP}, expr=['x 0 max 1 min'])\n`;

    // Determine num_streams value (default to 2 if not specified)
    const callOptions = { numStreams: numStreams ?? 2, useFp32 };

    // Generate model inference code based on model type
    if (modelType === 'vsr') {
      // Use temporalFrames parameter or default to 5 for backward compatibility
      const frames = temporalFrames ?? 5;
      const halfFrames = Math.floor(frames / 2);

      code += `# Temporal upscaling (${frames}-frame VSR architecture)\n`;

      // Generate frame shift variables dynamically based on frame count
      const frameVars: string[] = [];
      for (let i = -halfFrames; i <= halfFrames; i++) {
        if (i === 0) {
          frameVars.push(CLIP);
        } else {
          const varName = i < 0 ? `m${Math.abs(i)}` : `p${i}`;
          const shift = Math.abs(i);
          if (i < 0) {
            code += `${varName} = ${CLIP}[:${shift}] + ${CLIP}[:-${shift}]   # shift ${i}\n`;
          } else {
            code += `${varName} = ${CLIP}[${shift}:] + ${CLIP}[-${shift}:]   # shift +${i}\n`;
          }
          frameVars.push(varName);
        }
      }

      // The model copies frame props from its first clip, which holds the
      // earliest neighbour; each frame takes its own back, durations included.
      code += `_vk_centre = ${CLIP}\n`;
      code += provider.modelCallCode(`[${frameVars.join(', ')}]`, modelFile, callOptions);
      code += `${CLIP} = core.std.CopyFrameProps(${CLIP}, _vk_centre)\n`;
      code += '\n';
    } else {
      code += '# Single-frame upscaling (non-temporal architecture)\n';
      code += provider.modelCallCode(CLIP, modelFile, callOptions);
      code += '\n';
    }

    // Convert to YUV for filter compatibility
    code += '# Convert to YUV for filter compatibility\n';
    code += `${CLIP} = core.resize.Point(${CLIP}, format=vs.YUV444P16, matrix_s="709", primaries_s="709", transfer_s="709")\n\n`;

    return code;
  }

  async cleanupScript(scriptPath: string): Promise<void> {
    try {
      await fs.remove(scriptPath);
      await fs.remove(timecodesPathFor(scriptPath));
    } catch (error) {
      logger.error('Error cleaning up script:', error);
    }
  }
}
