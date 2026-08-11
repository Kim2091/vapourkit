// electron/scriptGenerator.ts
import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import { PATHS } from './constants';
import { configManager } from './configManager';
import { logger } from './logger';
import { BACKENDS, resolveBackendId, resolveFilterBackend, type BackendId, type FilterBackend } from './providers/descriptors';
import { getProvider } from './providers/registry';
import type { InferenceProvider } from './providers/types';

export type ModelType = 'vsr' | 'image';

export interface Filter {
  id: string;
  enabled: boolean;
  filterType: 'aiModel' | 'custom';
  preset: string;
  code: string;
  order: number;
  modelPath?: string;
  modelType?: 'vsr' | 'image';
  /** Inference backend override for this filter; 'auto' or unset inherits the app default. */
  backend?: FilterBackend;
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
  private getTemplatePath(): string {
    const templateName = 'vapoursynth_template.vpy';
    const templatePath = path.join(PATHS.CONFIG, templateName);
    return templatePath;
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

    let code = '# Inference backend selected in the app; vk_backend() resolves it to a\n';
    code += '# vsmlrt Backend for custom filters (kwargs pass through, e.g. fp16=True)\n';
    code += `VK_BACKEND = "${defaultBackend}"\n`;
    code += 'def vk_backend(**kwargs):\n';
    code += '    from vsmlrt import Backend\n';
    code += `    return {${mapEntries}}[VK_BACKEND](**kwargs)\n\n`;
    return code;
  }

  async generateScript(config: ScriptConfig): Promise<string> {
    const templatePath = this.getTemplatePath();
    let template = await fs.readFile(templatePath, 'utf-8');

    const defaultBackend = resolveBackendId(config.defaultBackend);

    // Apply colorimetry settings
    const overwriteMatrix = config.colorimetry?.overwriteMatrix ? 'True' : 'False';
    const matrix709 = config.colorimetry?.matrix709 ? 'True' : 'False';
    const defaultMatrix = config.colorimetry?.defaultMatrix || '709';
    const defaultPrimaries = config.colorimetry?.defaultPrimaries || '709';
    const defaultTransfer = config.colorimetry?.defaultTransfer || '709';
    const outputFormat = config.outputFormat || 'vs.YUV420P8';

    // Process filters sequentially
    const filters = config.filters || [];
    const enabledFilters = filters.filter(f => f.enabled).sort((a, b) => a.order - b.order);

    let filterCode = this.generateBackendHelper(defaultBackend);

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
      filterCode += '# Preview outputs (named tabs in vs-view)\n';
      filterCode += 'try:\n';
      filterCode += '    from vsview import set_output as _vk_set_output\n';
      filterCode += 'except ImportError:\n';
      filterCode += '    def _vk_set_output(c, i, n=None):\n';
      filterCode += '        c.set_output(i)\n';
      filterCode += '_vk_set_output(original_clip, 0, "Source")\n\n';
    }

    const pyStr = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    let previewOutputIndex = 0;

    for (let i = 0; i < enabledFilters.length; i++) {
      const filter = enabledFilters[i];
      let stageLabel: string | null = null;

      if (filter.filterType === 'aiModel' && filter.modelPath) {
        // Generate AI model upscaling code with this filter's effective backend
        // Check precision and model type for THIS specific model from config, not filter state
        const provider = getProvider(resolveFilterBackend(filter.backend, defaultBackend));
        const filterUseFp32 = configManager.isModelFp32(filter.modelPath);
        const filterModelType = configManager.getModelType(filter.modelPath);
        const filterTemporalFrames = configManager.getTemporalFrames(filter.modelPath);
        filterCode += this.generateAIModelCode(filter, provider, filterUseFp32, filterModelType, defaultMatrix, defaultPrimaries, defaultTransfer, config.numStreams, filterTemporalFrames);
        stageLabel = path.basename(filter.modelPath).replace(/\.(onnx|engine)$/i, '');
      } else if (filter.filterType === 'custom' && filter.code.trim()) {
        // Insert custom filter code
        filterCode += '# Custom Filter: ' + (filter.preset || 'Unnamed') + '\n';
        filterCode += filter.code.trim() + '\n\n';
        stageLabel = filter.preset || 'Custom Filter';
      }

      // Register an output after each stage that actually emitted code
      if (config.generatePreviewOutputs && stageLabel !== null) {
        previewOutputIndex++;
        filterCode += `_vk_set_output(clip, ${previewOutputIndex}, ${pyStr(`${previewOutputIndex}. ${stageLabel}`)})\n\n`;
      }
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
