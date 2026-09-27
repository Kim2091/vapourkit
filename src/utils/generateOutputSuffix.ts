import type { Filter, SegmentSelection } from '../electron.d';

// The descriptive part of an output filename: what was done to the video, in
// the order it was done, from facts rather than guesses.
//
// Each enabled step contributes a tag in chain order: an AI model by its own
// name, a filter by what its category says it does. Resolution and frame rate
// are added only when the app has evaluated the script and knows them, and
// only when they differ from the source - a height guessed from a model's
// filename was wrong whenever a resize, crop or second model was in the chain.

/**
 * What a filter category says about the picture, as a filename tag. Keys are
 * the categories the shipped templates actually use (lower-cased). An empty
 * tag means the step does not describe the result - a mask, a utility, a
 * comparison - and is left out. "Hybrid" marks where a template came from,
 * not what it does, so it is skipped in favour of the category beside it.
 */
const CATEGORY_TAGS: Record<string, string> = {
  'denoising': 'denoise',
  'deblocking': 'deblock',
  'debanding': 'deband',
  'cleaning': 'clean',
  'restoration': 'restore',
  'stabilization': 'stabilize',
  'temporal smoothing': 'smooth',
  'sharpening': 'sharpen',
  'blurring': 'blur',
  'anti-aliasing': 'aa',
  'dehalo': 'dehalo',
  'deinterlacing': 'deint',
  'frame rate': 'framerate',
  'frame recovery': 'framefix',
  'frame manipulation': 'frames',
  'color modification': 'color',
  'resizing': 'resize',
  'unresize': 'descale',
  'padding/cropping': 'crop',
  'transform': 'transform',
  'lines': 'lines',
  'effects': 'fx',
  'overlays': 'overlay',
  'tiling': 'tile',
  'grain': 'grain',
  'chroma': 'chroma',
  'frame interpolation': 'interp',
  // Limit Filter only clamps how far another filter moved the picture.
  'limiting': '',
  'masking': '',
  'utility': '',
  'comparison': '',
};

const SOURCE_CATEGORIES = new Set(['hybrid']);

/**
 * Filters whose category misdescribes them in a filename, by template name
 * (lower-cased). Modulus pads to a size a model accepts, and a Crop later in
 * the chain takes that back off, so it changed nothing a name should mention;
 * Balance Borders evens out edges rather than cropping.
 */
const NAME_TAGS: Record<string, string> = {
  'modulus': '',
  'balance borders': 'borders',
};

/** Longest a single tag may be; a model or filter name past this is cut. */
const MAX_TAG_LENGTH = 24;
/** Longest the whole suffix may be. Whole tags are dropped to fit, never cut. */
const MAX_SUFFIX_LENGTH = 64;

function sanitizeTag(tag: string): string {
  return tag.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, MAX_TAG_LENGTH);
}

/** A filter's tag: '' when it does not describe the result. */
function filterTag(filter: Filter): string {
  const named = NAME_TAGS[filter.preset.toLowerCase().trim()];
  if (named !== undefined) return named;
  const categories = filter.category === undefined ? [] : Array.isArray(filter.category) ? filter.category : [filter.category];
  const known = categories
    .map(category => category.toLowerCase().trim())
    .filter(category => !SOURCE_CATEGORIES.has(category));
  for (const category of known) {
    if (category in CATEGORY_TAGS) return CATEGORY_TAGS[category];
  }
  // A category we have no word for: the filter's own name says more than
  // the first word of it did.
  return sanitizeTag(filter.preset);
}

/**
 * Build tokens a model file carries that say nothing about the model:
 * precision, opset, dynamic-shape markers, input shapes like 1x3xHxW.
 */
const MODEL_NOISE = /^(fp16|fp32|bf16|int8|op\d+|opset\d+|dyn|dynamic|static|hw|onnx|trt|engine|(?:\d+|[hw])(?:x(?:\d+|[hw])){2,})$/i;

/** An AI model's tag: its file name without the build details. */
export function modelTag(modelPath: string): string {
  const base = (modelPath.split(/[\\/]/).pop() || modelPath).replace(/\.[^.]+$/, '');
  const words = base.split(/[_\-\s.]+/).filter(word => word && !MODEL_NOISE.test(word));
  return sanitizeTag(words.join('')) || 'model';
}

function parseResolution(resolution: string | null | undefined): { width: number; height: number } | null {
  const match = resolution?.toLowerCase().match(/(\d+)\s*x\s*(\d+)/);
  if (!match) return null;
  const width = parseInt(match[1], 10);
  const height = parseInt(match[2], 10);
  return width > 0 && height > 0 ? { width, height } : null;
}

function parseFps(fps: string | number | null | undefined): number | null {
  if (fps === null || fps === undefined || fps === '') return null;
  const value = typeof fps === 'number' ? fps : parseFloat(String(fps));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** "59.94fps", "60fps": two decimals at most, trailing zeros dropped. */
function fpsTag(fps: number): string {
  return `${parseFloat(fps.toFixed(2))}fps`;
}

export interface GenerateOutputSuffixOptions {
  inputResolution?: string | null;
  /** The evaluated script's output, once the workflow has been validated */
  outputResolution?: string | null;
  inputFps?: string | number | null;
  outputFps?: string | number | null;
}

export function generateOutputSuffix(
  workflow: {
    colorimetry?: any;
    filters: Filter[];
    segment?: SegmentSelection;
  },
  options?: GenerateOutputSuffixOptions
): string {
  const steps: string[] = [];

  if (workflow.colorimetry?.overwriteMatrix || workflow.colorimetry?.matrix709) {
    steps.push('colorimetry');
  }

  // The chain, in order. A model step with no model file runs nothing.
  const chain = [...workflow.filters].filter(filter => filter.enabled).sort((a, b) => a.order - b.order);
  for (const filter of chain) {
    if (filter.filterType === 'aiModel') {
      if (filter.modelPath) steps.push(modelTag(filter.modelPath));
    } else {
      const tag = filterTag(filter);
      if (tag) steps.push(tag);
    }
  }

  // Facts about the result, only when known and different from the source.
  const facts: string[] = [];
  const input = parseResolution(options?.inputResolution);
  const output = parseResolution(options?.outputResolution);
  if (input && output && (input.width !== output.width || input.height !== output.height)) {
    // "2160p" while the shape is kept; the full size once it is not, since a
    // crop or pad to a new aspect is exactly what a height alone would hide.
    const sameShape = input.width * output.height === input.height * output.width;
    facts.push(sameShape ? `${output.height}p` : `${output.width}x${output.height}`);
  }
  const inputFps = parseFps(options?.inputFps);
  const outputFps = parseFps(options?.outputFps);
  if (inputFps && outputFps && Math.abs(inputFps - outputFps) > 0.01) {
    facts.push(fpsTag(outputFps));
  }
  if (workflow.segment?.enabled) {
    facts.push('trim');
  }

  // Once each, first occurrence kept: "denoise_sharpen_denoise" said nothing
  // the shorter form does not.
  const unique = (tags: string[]) => tags.filter((tag, index) => tags.indexOf(tag) === index);
  let kept = unique(steps);
  const tail = unique(facts);

  // Over the limit, the last steps go first; the facts about the result stay.
  const length = () => [...kept, ...tail].join('_').length;
  while (kept.length > 0 && length() > MAX_SUFFIX_LENGTH) {
    kept = kept.slice(0, -1);
  }

  const suffix = [...kept, ...tail].join('_');
  return suffix || 'processed';
}
