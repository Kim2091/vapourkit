// electron/configManager.ts
import * as fs from 'fs-extra';
import * as path from 'path';
import { PATHS } from './constants';
import { logger } from './logger';
import type { ModelType } from './scriptGenerator';

// Single source of truth for FFmpeg default arguments
export const DEFAULT_FFMPEG_ARGS = '-c:v libx264 -preset medium -crf 18 -map_metadata 1';

// Single source of truth for video-compare default arguments
export const DEFAULT_VIDEO_COMPARE_ARGS = '-W';

interface Filter {
  id: string;
  enabled: boolean;
  preset: string;
  code: string;
  order: number;
}

interface AppConfig {
  developerMode: boolean;
  colorMatrix?: {
    overwriteMatrix: boolean;
    matrix709: boolean;
    defaultMatrix: '709' | '170m';
    defaultPrimaries: '709' | '601';
    defaultTransfer: '709' | '170m';
  };
  panelSizes?: {
    leftPanel: number;
    rightPanel: number;
    queuePanel?: number;
  };
  showQueue?: boolean;
  filterPresets?: {
    prefilterPreset: string;
    postfilterPreset: string;
  };
  filterConfigurations?: Filter[];
  upscalePosition?: number;
  ffmpegArgs?: string;
  processingFormat?: string;
  videoCompareArgs?: string;
  vsMlrtVersion?: string;
  models: {
    [modelName: string]: {
      useFp32: boolean;
      modelType: ModelType;
      createdAt: string;
      displayTag?: string;
      description?: string;
    };
  };
}

const CONFIG_FILE = path.join(PATHS.CONFIG, 'app-config.json');

const DEFAULT_CONFIG: AppConfig = {
  developerMode: false,
  colorMatrix: {
    overwriteMatrix: false,
    matrix709: false,
    defaultMatrix: '709',
    defaultPrimaries: '709',
    defaultTransfer: '709'
  },
  panelSizes: {
    leftPanel: 60,
    rightPanel: 40,
    queuePanel: 25
  },
  showQueue: false,
  filterPresets: {
    prefilterPreset: '',
    postfilterPreset: ''
  },
  filterConfigurations: [],
  upscalePosition: 0,
  ffmpegArgs: DEFAULT_FFMPEG_ARGS,
  processingFormat: 'vs.YUV420P8',
  videoCompareArgs: DEFAULT_VIDEO_COMPARE_ARGS,
  vsMlrtVersion: undefined,
  models: {}
};

export class ConfigManager {
  private config: AppConfig = DEFAULT_CONFIG;

  async load(): Promise<void> {
    try {
      await fs.ensureDir(PATHS.CONFIG);
      
      if (await fs.pathExists(CONFIG_FILE)) {
        const data = await fs.readFile(CONFIG_FILE, 'utf-8');
        this.config = { ...DEFAULT_CONFIG, ...JSON.parse(data) };
        logger.info('Config loaded successfully');
      } else {
        logger.info('No config file found, using defaults (will be created during setup)');
        // Don't save here - let initializeUserConfig() copy the stock config with pre-packed models
      }
    } catch (error) {
      logger.error('Error loading config:', error);
      this.config = DEFAULT_CONFIG;
    }
  }

  async save(): Promise<void> {
    try {
      await fs.writeFile(CONFIG_FILE, JSON.stringify(this.config, null, 2), 'utf-8');
      logger.debug('Config saved successfully');
    } catch (error) {
      logger.error('Error saving config:', error);
    }
  }

  getDeveloperMode(): boolean {
    return this.config.developerMode;
  }

  async setDeveloperMode(enabled: boolean): Promise<void> {
    this.config.developerMode = enabled;
    await this.save();
  }

  async setModelMetadata(modelName: string, useFp32: boolean, modelType: ModelType = 'image', displayTag?: string, description?: string): Promise<void> {
    this.config.models[modelName] = {
      useFp32,
      modelType,
      createdAt: new Date().toISOString(),
      displayTag,
      description
    };
    await this.save();
  }

  getModelMetadata(modelName: string): { useFp32: boolean; modelType: ModelType; displayTag?: string; description?: string; createdAt?: string } | null {
    const metadata = this.config.models[modelName];
    if (!metadata) return null;
    
    // Ensure modelType exists (for backward compatibility with old configs)
    return {
      useFp32: metadata.useFp32,
      modelType: metadata.modelType || 'image',
      displayTag: metadata.displayTag,
      description: metadata.description,
      createdAt: metadata.createdAt
    };
  }

  async updateModelMetadata(modelName: string, updates: Partial<{ useFp32: boolean; modelType: ModelType; displayTag?: string; description?: string }>): Promise<void> {
    const existing = this.config.models[modelName];
    if (!existing) {
      throw new Error(`Model metadata not found for: ${modelName}`);
    }
    
    this.config.models[modelName] = {
      ...existing,
      ...updates
    };
    await this.save();
  }

  async deleteModelMetadata(modelName: string): Promise<void> {
    delete this.config.models[modelName];
    await this.save();
  }

  isModelFp32(modelPath: string): boolean {
    const filename = path.basename(modelPath, path.extname(modelPath));
    const metadata = this.getModelMetadata(filename);
    // Use metadata from config, default to false (fp16) if not found
    return metadata?.useFp32 ?? false;
  }

  getModelType(modelPath: string): ModelType {
    const filename = path.basename(modelPath, path.extname(modelPath));
    const metadata = this.getModelMetadata(filename);
    // Return stored model type, default to 'image' as it's the most common type
    return metadata?.modelType || 'image';
  }

  getColorMatrixSettings(): { overwriteMatrix: boolean; matrix709: boolean; defaultMatrix: '709' | '170m'; defaultPrimaries: '709' | '601'; defaultTransfer: '709' | '170m' } {
    return this.config.colorMatrix || DEFAULT_CONFIG.colorMatrix!;
  }

  async setColorMatrixSettings(settings: { overwriteMatrix: boolean; matrix709: boolean; defaultMatrix: '709' | '170m'; defaultPrimaries: '709' | '601'; defaultTransfer: '709' | '170m' }): Promise<void> {
    this.config.colorMatrix = settings;
    await this.save();
  }

  getPanelSizes(): { leftPanel: number; rightPanel: number; queuePanel?: number } {
    return this.config.panelSizes || DEFAULT_CONFIG.panelSizes!;
  }

  async setPanelSizes(sizes: { leftPanel: number; rightPanel: number; queuePanel?: number }): Promise<void> {
    this.config.panelSizes = { ...this.config.panelSizes, ...sizes };
    await this.save();
  }

  getShowQueue(): boolean {
    return this.config.showQueue ?? false;
  }

  async setShowQueue(show: boolean): Promise<void> {
    this.config.showQueue = show;
    await this.save();
  }

  getFilterPresets(): { prefilterPreset: string; postfilterPreset: string } {
    return this.config.filterPresets || DEFAULT_CONFIG.filterPresets!;
  }

  async setFilterPresets(presets: { prefilterPreset: string; postfilterPreset: string }): Promise<void> {
    this.config.filterPresets = presets;
    await this.save();
  }

  getFilterConfigurations(): Filter[] {
    return this.config.filterConfigurations || DEFAULT_CONFIG.filterConfigurations!;
  }

  async setFilterConfigurations(filters: Filter[]): Promise<void> {
    this.config.filterConfigurations = filters;
    await this.save();
  }

  getUpscalePosition(): number {
    return this.config.upscalePosition ?? DEFAULT_CONFIG.upscalePosition!;
  }

  async setUpscalePosition(position: number): Promise<void> {
    this.config.upscalePosition = position;
    await this.save();
  }

  getFfmpegArgs(): string {
    return this.config.ffmpegArgs ?? DEFAULT_CONFIG.ffmpegArgs!;
  }

  async setFfmpegArgs(args: string): Promise<void> {
    this.config.ffmpegArgs = args;
    await this.save();
  }

  getProcessingFormat(): string {
    return this.config.processingFormat ?? 'vs.YUV420P8';
  }

  async setProcessingFormat(format: string): Promise<void> {
    this.config.processingFormat = format;
    await this.save();
  }

  getDefaultFfmpegArgs(): string {
    return DEFAULT_FFMPEG_ARGS;
  }

  getVideoCompareArgs(): string {
    return this.config.videoCompareArgs ?? DEFAULT_VIDEO_COMPARE_ARGS;
  }

  async setVideoCompareArgs(args: string): Promise<void> {
    this.config.videoCompareArgs = args;
    await this.save();
  }

  getDefaultVideoCompareArgs(): string {
    return DEFAULT_VIDEO_COMPARE_ARGS;
  }

  getVsMlrtVersion(): string | undefined {
    return this.config.vsMlrtVersion;
  }

  async setVsMlrtVersion(version: string): Promise<void> {
    this.config.vsMlrtVersion = version;
    await this.save();
  }
}

export const configManager = new ConfigManager();