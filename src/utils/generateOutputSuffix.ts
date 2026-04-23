import type { Filter, SegmentSelection } from '../electron.d';

/**
 * Maps filter categories to short filename-safe tags.
 */
const CATEGORY_TAG_MAP: Record<string, string> = {
  'denoise/deblock': 'denoise',
  'deinterlace': 'deinterlace',
  'anti-aliasing/dehalo': 'dehalo',
  'resize/transform': 'resize',
  'color': 'color',
  'frame rate': 'framerate',
  'sharpen/detail': 'sharpen',
  'grain/noise': 'grain',
  'stabilize/fix': 'stabilize',
};

function getCategoryTag(category: string | string[] | undefined, preset: string): string {
  if (category) {
    const categories = Array.isArray(category) ? category : [category];
    for (const cat of categories) {
      const normalized = cat.toLowerCase().trim();
      if (CATEGORY_TAG_MAP[normalized]) {
        return CATEGORY_TAG_MAP[normalized];
      }
    }
  }
  // Fallback: first alphanumeric word of preset
  const match = preset.match(/[a-zA-Z0-9]+/);
  return match ? match[0].toLowerCase() : 'filter';
}

function extractScaleFromModelPath(modelPath: string): number | null {
  const basename = modelPath.split(/[\\/]/).pop() || modelPath;
  // Try patterns like 4x, 2X, x4, X2
  const match = basename.match(/(?:^|\b|_)(\d)[xX]/) || basename.match(/[xX](\d)(?:\b|_|\.)/);
  if (match) {
    const scale = parseInt(match[1], 10);
    if (scale > 0) return scale;
  }
  return null;
}

function parseResolutionHeight(resolution: string | null | undefined): number | null {
  if (!resolution) return null;
  const parts = resolution.toLowerCase().split('x');
  if (parts.length >= 2) {
    const height = parseInt(parts[1].trim(), 10);
    if (!isNaN(height) && height > 0) return height;
  }
  return null;
}

function deduplicateConsecutive<T>(arr: T[]): T[] {
  return arr.filter((item, index) => index === 0 || item !== arr[index - 1]);
}

function sanitizeTag(tag: string): string {
  return tag.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

export interface GenerateOutputSuffixOptions {
  inputResolution?: string | null;
  outputResolution?: string | null;
}

export function generateOutputSuffix(
  workflow: {
    colorimetry?: any;
    filters: Filter[];
    segment?: SegmentSelection;
    selectedModel?: string | null;
  },
  options?: GenerateOutputSuffixOptions
): string {
  const tags: string[] = [];

  // 1. Colorimetry
  if (workflow.colorimetry?.overwriteMatrix || workflow.colorimetry?.matrix709) {
    tags.push('colorimetry');
  }

  // 2. Custom filters
  const customFilters = workflow.filters.filter(f => f.enabled && f.filterType === 'custom');
  for (const filter of customFilters) {
    const tag = sanitizeTag(getCategoryTag(filter.category, filter.preset));
    if (tag) {
      tags.push(tag);
    }
  }

  // 3. AI Model scale
  const aiModels = workflow.filters.filter(f => f.enabled && f.filterType === 'aiModel' && f.modelPath);
  let scale: number | null = null;
  if (aiModels.length > 0) {
    scale = extractScaleFromModelPath(aiModels[0].modelPath!);
    if (scale) {
      tags.push(`${scale}x`);
    } else {
      tags.push('upscale');
    }
  }

  // Also check selectedModel if no AI model filter is in the filter chain
  if (aiModels.length === 0 && workflow.selectedModel) {
    scale = extractScaleFromModelPath(workflow.selectedModel);
    if (scale) {
      tags.push(`${scale}x`);
    } else {
      tags.push('upscale');
    }
  }

  // 4. Resize tag
  const inputHeight = parseResolutionHeight(options?.inputResolution);
  const outputHeight = parseResolutionHeight(options?.outputResolution);
  if (outputHeight && inputHeight && outputHeight !== inputHeight) {
    tags.push(`resize${outputHeight}`);
  } else if (scale && inputHeight) {
    const estimatedHeight = inputHeight * scale;
    tags.push(`resize${estimatedHeight}`);
  }

  // 5. Segment / trim
  if (workflow.segment?.enabled) {
    tags.push('trim');
  }

  // Deduplicate consecutive identical tags
  const dedupedTags = deduplicateConsecutive(tags);

  if (dedupedTags.length === 0) {
    return 'processed';
  }

  let suffix = dedupedTags.join('_');

  // Truncate to 32 characters if needed
  if (suffix.length > 32) {
    suffix = suffix.slice(0, 32);
  }

  return suffix;
}
