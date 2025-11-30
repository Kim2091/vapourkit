// electron/scriptGenerator.ts
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import { PATHS } from './constants';
import { configManager } from './configManager';
import { logger } from './logger';

export type ModelType = 'tspan' | 'image';

export interface Filter {
  id: string;
  enabled: boolean;
  filterType: 'aiModel' | 'custom';
  preset: string;
  code: string;
  order: number;
  modelPath?: string;
  modelType?: 'tspan' | 'image';
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
  useDirectML?: boolean;
  useFp32?: boolean;
  modelType?: ModelType;
  upscalingEnabled?: boolean;
  colorMatrix?: {
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
}

export class VapourSynthScriptGenerator {
  private getTemplatePath(): string {
    const templateName = 'vapoursynth_template.vpy';
    const templatePath = path.join(PATHS.CONFIG, templateName);
    return templatePath;
  }

  async generateScript(config: ScriptConfig): Promise<string> {
    const templatePath = this.getTemplatePath();
    let template = await fs.readFile(templatePath, 'utf-8');

    // Apply color matrix settings
    const overwriteMatrix = config.colorMatrix?.overwriteMatrix ? 'True' : 'False';
    const matrix709 = config.colorMatrix?.matrix709 ? 'True' : 'False';
    const defaultMatrix = config.colorMatrix?.defaultMatrix || '709';
    const defaultPrimaries = config.colorMatrix?.defaultPrimaries || '709';
    const defaultTransfer = config.colorMatrix?.defaultTransfer || '709';
    const outputFormat = config.outputFormat || 'vs.YUV420P8';

    // Process filters sequentially
    const filters = config.filters || [];
    const enabledFilters = filters.filter(f => f.enabled).sort((a, b) => a.order - b.order);
    
    let filterCode = '';
    
    // Add segment trimming if enabled
    if (config.segment?.enabled) {
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
    
    for (const filter of enabledFilters) {
      if (filter.filterType === 'aiModel' && filter.modelPath) {
        // Generate AI model upscaling code
        // Check precision and model type for THIS specific model from config, not filter state
        const filterUseFp32 = configManager.isModelFp32(filter.modelPath);
        const filterModelType = configManager.getModelType(filter.modelPath);
        filterCode += this.generateAIModelCode(filter, config.useDirectML || false, filterUseFp32, filterModelType, defaultMatrix, defaultPrimaries, defaultTransfer, config.numStreams);
      } else if (filter.filterType === 'custom' && filter.code.trim()) {
        // Insert custom filter code
        filterCode += '# Custom Filter: ' + (filter.preset || 'Unnamed') + '\n';
        filterCode += filter.code.trim() + '\n\n';
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

    // Use timestamp + random string for unique script path to avoid collisions in batch processing
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substring(2, 9);
    const tempScriptPath = path.join(os.tmpdir(), `tspan_upscale_${timestamp}_${randomId}.vpy`);
    await fs.writeFile(tempScriptPath, template, 'utf-8');
    
    logger.info(`Generated script: ${tempScriptPath}`);
    return tempScriptPath;
  }

  /**
   * Generate VapourSynth code for an AI model filter
   */
  private generateAIModelCode(filter: Filter, useDirectML: boolean, useFp32: boolean, modelType: ModelType, defaultMatrix: string, defaultPrimaries: string, defaultTransfer: string, numStreams?: number): string {
    if (!filter.modelPath) return '';
    
    // Constants for VapourSynth variable names
    const CLIP = 'clip';
    const M2 = 'm2';
    const M1 = 'm1';
    const P1 = 'p1';
    const P2 = 'p2';
    
    let code = '# AI Model\n';
    
    // Add RGB conversion before model processing and clamp to 0-1 range
    // Use RGBS (float32) for fp32 models, RGBH (float16) for fp16 models
    const rgbFormat = useFp32 ? 'vs.RGBS' : 'vs.RGBH';
    code += '# Convert to RGB format for upscaling\n';
    code += `if ${CLIP}.format.id != ${rgbFormat}:\n`;
    code += `    ${CLIP} = core.resize.Bilinear(${CLIP}, format=${rgbFormat}, matrix_in_s="${defaultMatrix}", primaries_in_s="${defaultPrimaries}", transfer_in_s="${defaultTransfer}")\n`;
    code += `${CLIP} = core.std.Expr(${CLIP}, expr=['x 0 max 1 min'])\n`;
    
    // Set up model plugin and parameters
    let modelPlugin: string;
    let modelPathParam: string;
    let modelPath: string;
    let fp16Param: string;
    
    if (useDirectML) {
      modelPlugin = 'ort';
      modelPathParam = 'network_path';
      modelPath = filter.modelPath.replace(/\.engine$/, '.onnx');
      const useFp16 = !useFp32;
      fp16Param = `, provider="DML", device_id=0, fp16=${useFp16 ? 'True' : 'False'}, verbosity=4`;
    } else {
      modelPlugin = 'trt';
      modelPathParam = 'engine_path';
      modelPath = filter.modelPath;
      fp16Param = '';
    }
    
    // Determine num_streams value (default to 2 if not specified)
    const streams = numStreams ?? 2;
    
    // Generate model inference code based on model type
    if (modelType === 'tspan') {
      code += '# Temporal upscaling (5-frame TSPAN architecture)\n';
      code += `${M2} = ${CLIP}[:2] + ${CLIP}[:-2]   # shift -2\n`;
      code += `${M1} = ${CLIP}[:1] + ${CLIP}[:-1]   # shift -1\n`;
      code += `${P1} = ${CLIP}[1:] + ${CLIP}[-1:]   # shift +1\n`;
      code += `${P2} = ${CLIP}[2:] + ${CLIP}[-2:]   # shift +2\n`;
      code += `${CLIP} = core.${modelPlugin}.Model([${M2}, ${M1}, ${CLIP}, ${P1}, ${P2}], ${modelPathParam}="${modelPath.replace(/\\/g, '/')}", num_streams=${streams}${fp16Param})\n\n`;
    } else {
      code += '# Single-frame upscaling (non-temporal architecture)\n';
      code += `${CLIP} = core.${modelPlugin}.Model(${CLIP}, ${modelPathParam}="${modelPath.replace(/\\/g, '/')}", num_streams=${streams}${fp16Param})\n\n`;
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