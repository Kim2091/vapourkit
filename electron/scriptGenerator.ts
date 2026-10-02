// electron/scriptGenerator.ts
import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import { PATHS } from './constants';
import { getSystemRoot } from './trtexecShim';
import { configManager } from './configManager';
import { logger } from './logger';
import { BACKENDS, normalizeBackendForPlatform, resolveFilterBackend, type BackendId, type FilterBackend } from './providers/descriptors';
import { getProvider } from './providers/registry';
import type { InferenceProvider } from './providers/types';
import { parseReferenceVideo } from './referenceVideo';
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
  enginePath: string;
  pluginsPath: string;
  outputPath?: string;
  /** App-level default inference backend; per-filter overrides resolve against it. */
  defaultBackend?: string;
  useFp32?: boolean;
  modelType?: ModelType;
  upscalingEnabled?: boolean;
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

  /** Whether some enabled filter reads its picture from a video file. */
  private readsReferenceVideo(enabledFilters: Filter[]): boolean {
    return enabledFilters.some(filter => filter.filterType === 'custom'
      && [...filter.code.matchAll(STAGE_REFERENCE)].some(([, variable]) => parseReferenceVideo(this.stageIdOf(filter, variable))));
  }

  /**
   * vk_paired_by_time() and vk_reference_video(): a picture from another
   * timeline, lined up with the step reading it.
   *
   * Another video — a side chain's, or a file named directly — is another
   * release of the same footage, and two releases rarely share a frame rate:
   * a telecined 29.97 DVD remux against a 23.976 encode of the same disc is
   * the ordinary case. So frames are paired by time, not by number. Each frame
   * of `like` (the clip at the reading step, after any IVTC or trim above it)
   * gets the frame of `ref` nearest its timestamp, counted from `first` — where
   * the reading chain's segment starts, in its source's frames — then moved by
   * `offset` frames of `ref`. Pairing by number put a 29.97 source 2,000
   * frames away from its 23.976 reference by the six-minute mark.
   *
   * Past either end the nearest frame is held, so a reference a few frames
   * short of the source still works. A clip with no constant frame rate falls
   * back to pairing by number, which is all there is to go on.
   */
  private generatePairingHelpers(): string {
    return [
      'def vk_paired_by_time(ref, like, first=0, offset=0):',
      '    from fractions import Fraction as _vk_Fraction',
      '    if offset >= ref.num_frames:',
      '        raise ValueError("The reference offset %d is past its end; it has %d frames." % (offset, ref.num_frames))',
      '    last = ref.num_frames - 1',
      '    if original_clip.fps_num and like.fps_num and ref.fps_num:',
      '        start = _vk_Fraction(first) / original_clip.fps',
      '        def _at(n):',
      '            return offset + int((start + _vk_Fraction(n) / like.fps) * ref.fps + _vk_Fraction(1, 2))',
      '    else:',
      '        def _at(n):',
      '            return offset + first + n',
      '    timing = {"fpsnum": like.fps_num, "fpsden": like.fps_den} if like.fps_num else {}',
      '    base = core.std.BlankClip(ref, length=like.num_frames, **timing)',
      '    return core.std.FrameEval(base, lambda n: ref[min(max(_at(n), 0), last)])',
      '',
      'def vk_reference_video(path, offset, like, first=0):',
      '    import os as _vk_os',
      '    if not _vk_os.path.isfile(path):',
      '        raise ValueError("The reference video " + path + " is not there any more. Pick it again.")',
      '    return vk_paired_by_time(core.bs.VideoSource(source=path, cachemode=3), like, first, offset)',
      '',
      '',
    ].join('\n');
  }

  /**
   * vk_open_video(), a side chain's source, prepared the way the template
   * prepares the main one: the same colour tagging when the app overwrites it,
   * then the same 16-bit YUV working format, so every filter meets the same
   * kind of picture in either chain. The template's own settings are read
   * where it defined them, with its defaults when a customised template does
   * not define one.
   */
  private generateOpenVideoHelper(): string {
    return [
      'def vk_open_video(path):',
      '    import os as _vk_os',
      '    if not _vk_os.path.isfile(path):',
      '        raise ValueError("The side chain video " + path + " is not there any more. Choose it again on its Load Video step.")',
      '    v = core.bs.VideoSource(source=path, cachemode=3)',
      '    _g = globals()',
      '    _matrix, _primaries, _transfer = _g.get("default_matrix", "709"), _g.get("default_primaries", "709"), _g.get("default_transfer", "709")',
      '    if _g.get("overwrite_matrix", False) and v.format.color_family != vs.RGB:',
      '        if _g.get("matrix_709", True):',
      '            v = core.std.SetFrameProps(v, _Matrix=vs.MATRIX_BT709, _Transfer=vs.TRANSFER_BT709, _Primaries=vs.PRIMARIES_BT709, _ColorRange=vs.RANGE_LIMITED)',
      '        else:',
      '            v = core.std.SetFrameProps(v, _Matrix=vs.MATRIX_ST170_M, _Transfer=vs.TRANSFER_BT601, _Primaries=vs.PRIMARIES_ST170_M, _ColorRange=vs.RANGE_LIMITED)',
      '    fmt = core.query_video_format(vs.YUV, vs.INTEGER, _g.get("default_depth", 16), v.format.subsampling_w, v.format.subsampling_h)',
      '    if v.format.id != fmt.id:',
      '        if v.format.color_family == vs.RGB:',
      '            v = core.resize.Point(v, format=fmt.id, primaries_in_s="709", transfer_in_s="709", matrix_s=_matrix, primaries_s=_primaries, transfer_s=_transfer)',
      '        else:',
      '            v = core.resize.Point(v, format=fmt.id, matrix_in_s=_matrix, primaries_in_s=_primaries, transfer_in_s=_transfer)',
      '    return v',
      '',
      '# An aligned side chain\'s video, put on the main source\'s timeline: frame n',
      '# is the moment at main frame n, by the mapping align_videos.py measured',
      '# (reference time = speed * main time + the offset of that time\'s section).',
      'def vk_conform(ref, speed, sections):',
      '    if not (vk_source.fps_num and ref.fps_num):',
      '        return ref',
      '    src_fps, ref_fps, last = float(vk_source.fps), float(ref.fps), ref.num_frames - 1',
      '    def _at(n):',
      '        t = n / src_fps',
      '        offset = sections[0][1]',
      '        for start, value in sections:',
      '            if t >= start:',
      '                offset = value',
      '        return min(max(int((speed * t + offset) * ref_fps + 0.5), 0), last)',
      '    base = core.std.BlankClip(ref, length=vk_source.num_frames, fpsnum=vk_source.fps_num, fpsden=vk_source.fps_den)',
      '    return core.std.FrameEval(base, lambda n: ref[_at(n)])',
      '',
      '',
    ].join('\n');
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
        return `vk_reference_video(${pyString(reference.video.path)}, ${reference.video.offset}, clip, ${first})`;
      case 'chain':
        // Its own timeline: lined up by time with the clip reading it.
        return emitted.has(id)
          ? `vk_paired_by_time(${STAGES}[${pyString(id)}], clip, ${first})`
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
   * Python helper injected ahead of the filter chain. Custom .vkfilter code
   * calls vk_backend(...) to get a vsmlrt Backend instance matching the
   * app-selected backend, so filters follow the backend dropdown without
   * hardcoding one (they can still construct a specific vsmlrt Backend to
   * override). The id → vsmlrt attribute map is generated from the backend
   * registry, so new backends are available here automatically.
   */
  private generateBackendHelper(defaultBackend: BackendId): string {
    const mapEntries = BACKENDS
      .map(d => `"${d.id}": Backend.${d.vsmlrtBackendAttr}`)
      .join(', ');
    const buildEnvEntries = Object.entries(this.getEngineBuildEnv())
      .map(([key, value]) => `${pyString(key)}: ${pyString(value)}`)
      .join(', ');

    let code = '# Inference backend selected in the app; vk_backend() resolves it to a\n';
    code += '# vsmlrt Backend for custom filters (kwargs pass through, e.g. fp16=True)\n';
    code += `VK_BACKEND = "${defaultBackend}"\n`;
    code += '# vsmlrt builds TensorRT engines at runtime by spawning trtexec with a nearly\n';
    code += '# empty environment; these are what the app\'s trtexec shim needs to start.\n';
    code += `VK_BUILD_ENV = {${buildEnvEntries}}\n`;
    code += 'def vk_backend(backend="auto", **kwargs):\n';
    code += '    from vsmlrt import Backend\n';
    code += '    backend = VK_BACKEND if backend == "auto" else backend.lower()\n';
    code += `    backend = {${mapEntries}}[backend](**kwargs)\n`;
    code += '    if hasattr(backend, "custom_env"):\n';
    code += '        for _key, _value in VK_BUILD_ENV.items():\n';
    code += '            backend.custom_env.setdefault(_key, _value)\n';
    code += '    # vsmlrt runs migraphx-driver with custom_env as its WHOLE environment,\n';
    code += '    # so an empty one leaves HIP without PATH, HOME or its cache folders\n';
    code += '    if type(backend).__name__ == "MIGX":\n';
    code += '        import os as _vk_os\n';
    code += '        for _key, _value in _vk_os.environ.items():\n';
    code += '            backend.custom_env.setdefault(_key, _value)\n';
    code += '    return backend\n';
    code += this.generateMigxHelper();
    code += '# vsmlrt model zoo location (downloaded by the app; the pip vs-mlrt wheels\n';
    code += "# don't ship a models folder, so vsmlrt's default path doesn't exist)\n";
    code += 'try:\n';
    code += '    import vsmlrt as _vk_vsmlrt\n';
    code += `    _vk_vsmlrt.models_path = "${PATHS.VSMLRT_MODELS.replace(/\\/g, '/')}"\n`;
    code += '    # pip TensorRT ships no trtexec binary; the app writes a shim that runs\n';
    code += "    # its own Python API engine builder (see electron/trtexecShim.ts)\n";
    code += `    _vk_vsmlrt.trtexec_path = "${PATHS.TRTEXEC_SHIM.replace(/\\/g, '/')}"\n`;
    code += '    # vsmlrt looks for migraphx-driver in a vsmlrt-hip folder beside the first\n';
    code += "    # vs-mlrt plugin it finds, which a pip install doesn't have\n";
    code += this.platform === 'win32'
      ? `    _vk_vsmlrt.migraphx_driver_path = ${pyString(PATHS.MIGX_DRIVER_WIN.replace(/\\/g, '/'))}\n`
      // The ROCm chosen in Settings names its own driver (rocmEnvironment.ts),
      // so a driver from another ROCm earlier on PATH cannot pair with its libraries
      : '    import os as _vk_os, shutil as _vk_shutil\n' +
        '    _vk_vsmlrt.migraphx_driver_path = _vk_os.environ.get("VK_MIGRAPHX_DRIVER") or ' +
        '_vk_shutil.which("migraphx-driver") or ' +
        '_vk_os.path.join(_vk_os.environ.get("ROCM_PATH", "/opt/rocm"), "bin", "migraphx-driver")\n';
    code += 'except Exception:\n';
    code += '    pass\n\n';
    return code;
  }

  /**
   * vk_migx_model(), which the MIGraphX provider's model step calls. vsmigx runs
   * programs compiled for one input size, so this compiles one at the clip's
   * resolution on first use — through vsmlrt's own migraphx_driver(), which
   * caches it beside the ONNX keyed by size, precision, MIGraphX version, GPU
   * and model checksum — and announces the compile with the [vk-build]
   * protocol so the app shows a banner instead of looking frozen.
   *
   * The clip is prepared in the float format of the model's *import*
   * precision, but vsmigx demands the program's I/O type; as with TensorRT
   * (#12) the call retries once in the other float format on a mismatch.
   */
  private generateMigxHelper(): string {
    return [
      'def vk_migx_model(clips, network_path, input_name="input", fp16=True, num_streams=1):',
      '    import os, sys',
      '    import vsmlrt as _vk_m',
      '    clips = clips if isinstance(clips, list) else [clips]',
      '    width, height = clips[0].width, clips[0].height',
      '    program = dict(network_path=network_path, opt_shapes=(width, height), fp16=fp16,',
      '                   fast_math=True, exhaustive_tune=False, device_id=0, short_path=None)',
      '    compiled = os.access(_vk_m.get_mxr_path(**program), os.R_OK)',
      '    label = f"Compiling MIGraphX program: {os.path.basename(network_path)} at {width}x{height}"',
      '    if not compiled:',
      '        print(f"[vk-build] begin {label}", file=sys.stderr, flush=True)',
      '    try:',
      '        mxr = _vk_m.migraphx_driver(channels=sum(c.format.num_planes for c in clips), input_name=input_name,',
      '                                    custom_env=dict(os.environ), **program)',
      '    finally:',
      '        if not compiled:',
      '            print(f"[vk-build] end {label}", file=sys.stderr, flush=True)',
      '    try:',
      '        return core.migx.Model(clips, mxr, num_streams=num_streams)',
      '    except vs.Error as _vk_migx_error:',
      '        # "sample type mismatch" / "bytes per sample mismatch"',
      '        if "sample" not in str(_vk_migx_error) or "mismatch" not in str(_vk_migx_error):',
      '            raise',
      '        bits = 32 if clips[0].format.bits_per_sample == 16 else 16',
      '        clips = [core.resize.Point(c, format=c.format.replace(bits_per_sample=bits)) for c in clips]',
      '        return core.migx.Model(clips, mxr, num_streams=num_streams)',
      '',
    ].join('\n');
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

  async generateScript(config: ScriptConfig): Promise<string> {
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

    if (sideChains.length > 0 || this.readsReferenceVideo(enabledFilters)) {
      filterCode += '# Pictures from another video, lined up by time with the step reading them\n';
      filterCode += this.generatePairingHelpers();
    }
    if (sideChains.length > 0) {
      filterCode += this.generateOpenVideoHelper();
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
      filterCode += `${STAGES} = {}\n`;
      filterCode += 'def vk_stage_missing(message):\n';
      filterCode += '    raise ValueError(message)\n\n';
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
      filterCode += `clip = vk_open_video(${pyString(head.sourcePath!)})\n`;
      const align = alignmentOf(chain);
      if (align) {
        const sections = align.sections.map(sec => `(${sec.from}, ${sec.offset})`).join(', ');
        filterCode += `clip = vk_conform(clip, ${align.speed}, [${sections}])\n`;
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

    // Replace all placeholders
    template = template
      .replace(/{{INPUT_VIDEO}}/g, config.inputVideo.replace(/\\/g, '/'))
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

    // Use timestamp + random string for unique script path to avoid collisions in batch processing
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substring(2, 9);
    const tempScriptPath = path.join(os.tmpdir(), `VSR_upscale_${timestamp}_${randomId}.vpy`);
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

      code += provider.modelCallCode(`[${frameVars.join(', ')}]`, modelFile, callOptions);
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
    } catch (error) {
      logger.error('Error cleaning up script:', error);
    }
  }
}
