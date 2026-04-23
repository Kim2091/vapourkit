// electron/configManager.ts
import * as fs from 'fs-extra';
import * as path from 'path';
import { PATHS } from './constants';
import { logger } from './logger';
import { getBundledBasePath } from './utils';
import type { ModelType } from './scriptGenerator';

// Single source of truth for FFmpeg default arguments
export const DEFAULT_FFMPEG_ARGS = '-c:v libx264 -preset medium -crf 18 -vf setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709 -map_metadata 1';

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
  colorimetry?: {
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
  filterConfigurations?: Filter[];
  upscalePosition?: number;
  ffmpegArgs?: string;
  processingFormat?: string;
  outputFormat?: string;
  videoCompareArgs?: string;
  defaultOutputFolder?: string;
  descriptiveNamingEnabled?: boolean;
  encodingSettingsExpanded?: boolean;
  vsMlrtVersion?: string;
  appVersion?: string;
  models: {
    [modelName: string]: {
      useFp32: boolean;
      useBf16?: boolean;
      modelType: ModelType;
      temporalFrames?: number; // Number of frames for VSR models (default: 5)
      createdAt: string;
      displayTag?: string;
      description?: string;
      category?: string | string[];
    };
  };
}

const CONFIG_FILE = path.join(PATHS.CONFIG, 'app-config.json');

const DEFAULT_CONFIG: AppConfig = {
  colorimetry: {
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
  filterConfigurations: [],
  upscalePosition: 0,
  ffmpegArgs: DEFAULT_FFMPEG_ARGS,
  processingFormat: 'vs.YUV420P8',
  outputFormat: 'mkv',
  videoCompareArgs: DEFAULT_VIDEO_COMPARE_ARGS,
  defaultOutputFolder: undefined,
  descriptiveNamingEnabled: true,
  encodingSettingsExpanded: false,
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
        const userConfig = JSON.parse(data) as Record<string, unknown>;
        const migratedConfig = await this.migrateConfigWithStock(userConfig);
        this.config = migratedConfig;
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

  private async migrateConfigWithStock(userConfig: Record<string, unknown>): Promise<AppConfig> {
    const stockConfig = await this.loadBundledStockConfig();
    const defaultConfigRecord = DEFAULT_CONFIG as unknown as Record<string, unknown>;

    if (!stockConfig) {
      return this.deepMerge(defaultConfigRecord, userConfig) as unknown as AppConfig;
    }

    const baseline = this.deepMerge(
      defaultConfigRecord,
      stockConfig
    );
    const merged = this.deepMerge(baseline, userConfig);

    const stockModels = this.asObject(stockConfig.models);
    const userModels = this.asObject(userConfig.models);
    merged.models = this.mergeModelMetadata(stockModels, userModels);

    if (!this.deepEqual(userConfig, merged)) {
      try {
        const backupPath = path.join(PATHS.CONFIG, `app-config.backup-${Date.now()}.json`);
        await fs.copy(CONFIG_FILE, backupPath);
        await fs.writeFile(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf-8');
        logger.info(`Migrated app config using stock defaults (backup: ${backupPath})`);
      } catch (writeError) {
        // Log but don't throw — the in-memory merged config is still valid.
        // A write failure here must never cause load() to fall back to DEFAULT_CONFIG.
        logger.warn(`Could not persist migrated config to disk (will retry on next save): ${writeError}`);
      }
    }

    return merged as unknown as AppConfig;
  }

  private async loadBundledStockConfig(): Promise<Record<string, unknown> | null> {
    try {
      const bundledBasePath = getBundledBasePath();
      const stockConfigPath = path.join(bundledBasePath, 'include', 'stock-app-config.json');
      if (!await fs.pathExists(stockConfigPath)) {
        logger.warn(`Bundled stock config not found at: ${stockConfigPath}`);
        return null;
      }

      return await fs.readJson(stockConfigPath) as Record<string, unknown>;
    } catch (error) {
      logger.warn(`Unable to load bundled stock config: ${error}`);
      return null;
    }
  }

  private mergeModelMetadata(
    stockModels: Record<string, unknown>,
    userModels: Record<string, unknown>
  ): Record<string, unknown> {
    const mergedModels: Record<string, unknown> = {};

    for (const [modelName, stockMetadata] of Object.entries(stockModels)) {
      const userMetadata = userModels[modelName];
      if (this.isObject(stockMetadata) && this.isObject(userMetadata)) {
        mergedModels[modelName] = this.deepMerge(stockMetadata, userMetadata);
      } else if (userMetadata !== undefined) {
        mergedModels[modelName] = userMetadata;
      } else {
        mergedModels[modelName] = stockMetadata;
      }
    }

    for (const [modelName, userMetadata] of Object.entries(userModels)) {
      if (!(modelName in mergedModels)) {
        mergedModels[modelName] = userMetadata;
      }
    }

    return mergedModels;
  }

  private deepMerge(
    base: Record<string, unknown>,
    override: Record<string, unknown>
  ): Record<string, unknown> {
    const result: Record<string, unknown> = { ...base };

    for (const [key, value] of Object.entries(override)) {
      const existing = result[key];
      if (this.isObject(existing) && this.isObject(value)) {
        result[key] = this.deepMerge(existing, value);
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  private deepEqual(left: unknown, right: unknown): boolean {
    if (left === right) return true;

    if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length !== right.length) return false;
      for (let index = 0; index < left.length; index++) {
        if (!this.deepEqual(left[index], right[index])) return false;
      }
      return true;
    }

    if (this.isObject(left) && this.isObject(right)) {
      const leftKeys = Object.keys(left);
      const rightKeys = Object.keys(right);
      if (leftKeys.length !== rightKeys.length) return false;

      for (const key of leftKeys) {
        if (!(key in right)) return false;
        if (!this.deepEqual(left[key], right[key])) return false;
      }

      return true;
    }

    return false;
  }

  private isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private asObject(value: unknown): Record<string, unknown> {
    return this.isObject(value) ? value : {};
  }

  async save(): Promise<void> {
    try {
      await fs.writeFile(CONFIG_FILE, JSON.stringify(this.config, null, 2), 'utf-8');
      logger.debug('Config saved successfully');
    } catch (error) {
      logger.error('Error saving config:', error);
    }
  }

  async setModelMetadata(modelName: string, useFp32: boolean, modelType: ModelType = 'image', displayTag?: string, description?: string, useBf16?: boolean, temporalFrames?: number): Promise<void> {
    this.config.models[modelName] = {
      useFp32,
      useBf16,
      modelType,
      temporalFrames,
      createdAt: new Date().toISOString(),
      displayTag,
      description
    };
    await this.save();
  }

  getModelMetadata(modelName: string): { useFp32: boolean; useBf16?: boolean; modelType: ModelType; temporalFrames?: number; displayTag?: string; description?: string; category?: string | string[]; createdAt?: string } | null {
    const metadata = this.config.models[modelName];
    if (!metadata) return null;
    
    // Ensure modelType exists (for backward compatibility with old configs)
    return {
      useFp32: metadata.useFp32,
      useBf16: metadata.useBf16,
      modelType: metadata.modelType || 'image',
      temporalFrames: metadata.temporalFrames,
      displayTag: metadata.displayTag,
      description: metadata.description,
      category: metadata.category,
      createdAt: metadata.createdAt
    };
  }

  async updateModelMetadata(modelName: string, updates: Partial<{ useFp32: boolean; useBf16?: boolean; modelType: ModelType; temporalFrames?: number; displayTag?: string; description?: string; category?: string | string[] }>): Promise<void> {
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

  getAllModelCategories(): string[] {
    const categories = new Set<string>();
    for (const model of Object.values(this.config.models)) {
      if (model.category) {
        if (Array.isArray(model.category)) {
          model.category.forEach(cat => categories.add(cat));
        } else {
          categories.add(model.category);
        }
      }
    }
    return [...categories].sort();
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

  getTemporalFrames(modelPath: string): number {
    const filename = path.basename(modelPath, path.extname(modelPath));
    const metadata = this.getModelMetadata(filename);
    // Return temporal frames count, default to 5 for backward compatibility
    return metadata?.temporalFrames ?? 5;
  }

  getColorimetrySettings(): { overwriteMatrix: boolean; matrix709: boolean; defaultMatrix: '709' | '170m'; defaultPrimaries: '709' | '601'; defaultTransfer: '709' | '170m' } {
    return this.config.colorimetry || DEFAULT_CONFIG.colorimetry!;
  }

  async setColorimetrySettings(settings: { overwriteMatrix: boolean; matrix709: boolean; defaultMatrix: '709' | '170m'; defaultPrimaries: '709' | '601'; defaultTransfer: '709' | '170m' }): Promise<void> {
    this.config.colorimetry = settings;
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
    const format = this.config.processingFormat ?? 'vs.YUV420P8';
    // Never return match_input as it's experimental - fallback to YUV420P8
    return format === 'match_input' ? 'vs.YUV420P8' : format;
  }

  async setProcessingFormat(format: string): Promise<void> {
    // Prevent saving match_input as it's experimental and can cause issues
    // Default to YUV420P8 if match_input is passed
    this.config.processingFormat = format === 'match_input' ? 'vs.YUV420P8' : format;
    await this.save();
  }

  getDefaultFfmpegArgs(): string {
    return DEFAULT_FFMPEG_ARGS;
  }

  getOutputFormat(): string {
    return this.config.outputFormat ?? 'mkv';
  }

  async setOutputFormat(format: string): Promise<void> {
    this.config.outputFormat = format;
    await this.save();
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

  getDefaultOutputFolder(): string | null {
    return this.config.defaultOutputFolder ?? null;
  }

  async setDefaultOutputFolder(folder: string | null): Promise<void> {
    this.config.defaultOutputFolder = folder ?? undefined;
    await this.save();
  }

  getDescriptiveNamingEnabled(): boolean {
    return this.config.descriptiveNamingEnabled ?? true;
  }

  async setDescriptiveNamingEnabled(enabled: boolean): Promise<void> {
    this.config.descriptiveNamingEnabled = enabled;
    await this.save();
  }

  getEncodingSettingsExpanded(): boolean {
    return this.config.encodingSettingsExpanded ?? false;
  }

  async setEncodingSettingsExpanded(expanded: boolean): Promise<void> {
    this.config.encodingSettingsExpanded = expanded;
    await this.save();
  }

  getVsMlrtVersion(): string | undefined {
    return this.config.vsMlrtVersion;
  }

  async setVsMlrtVersion(version: string): Promise<void> {
    this.config.vsMlrtVersion = version;
    await this.save();
  }

  getAppVersion(): string | undefined {
    return this.config.appVersion;
  }

  async setAppVersion(version: string): Promise<void> {
    this.config.appVersion = version;
    await this.save();
  }
}

export const configManager = new ConfigManager();