import { normalizeTrackSelection } from './mediaTracks';
// electron/encodingSettings.ts - The video encoding settings, and the FFmpeg arguments they resolve to.

import {
  clampQuality,
  generateFfmpegArgs,
  getAvailableEncoders,
  getAvailablePresets,
  getDefaultPreset,
  getRecommendedCrfRange,
  parseFfmpegArgs,
  simpleCodecOf,
  type Codec,
  type Encoder,
  type Preset,
} from './ffmpegConfig';

export type EncodingMode = 'simple' | 'advanced';
export type SimpleCodec = Exclude<Codec, 'custom'>;

/** What the simple controls pick. */
export interface SimpleEncoding {
  codec: SimpleCodec;
  encoder: Encoder;
  preset: Preset;
  quality: number;
  rateControl?: 'quality' | 'bitrate';
  bitrateMbps?: number;
  maxBitrateMbps?: number;
  keyframeInterval?: number;
  threads?: number;
  tune?: 'none' | 'film' | 'animation' | 'grain' | 'stillimage' | 'fastdecode' | 'zerolatency';
  proresProfile?: number;
  audioCodec?: 'copy' | 'aac' | 'ac3' | 'flac' | 'none';
  audioBitrateKbps?: number;
  audioChannels?: number;
  copyMetadata?: boolean;
  fastStart?: boolean;
}

/**
 * How a render encodes its video. The mode decides which half is used: the
 * simple controls, or the FFmpeg arguments typed in advanced mode. Normal
 * controls regenerate the advanced baseline whenever they change.
 */
export interface EncodingSettings {
  mode: EncodingMode;
  simple: SimpleEncoding;
  customArgs: string;
  /** Per-type ordinals, not global container indices. Undefined keeps all; [] removes all. */
  audioTracks?: number[];
  subtitleTracks?: number[];
}

const SIMPLE_CODECS: readonly SimpleCodec[] = ['h264', 'h265', 'av1', 'prores'];

export const DEFAULT_SIMPLE_ENCODING: SimpleEncoding = {
  codec: 'h264',
  encoder: 'software',
  preset: 'medium',
  quality: 18,
};

export const DEFAULT_ENCODING: EncodingSettings = {
  mode: 'simple',
  simple: DEFAULT_SIMPLE_ENCODING,
  customArgs: '',
};

/** The FFmpeg arguments the simple controls stand for. */
export function simpleArgsOf(value: SimpleEncoding): string {
  const simple = normalizeSimple(value) ?? DEFAULT_SIMPLE_ENCODING;
  let args = generateFfmpegArgs({ codec: simple.codec, encoder: simple.encoder, preset: simple.preset, crf: simple.quality,
    rateControl: simple.rateControl, bitrateMbps: simple.bitrateMbps });
  if (simple.codec !== 'prores' && simple.maxBitrateMbps) args += ` -maxrate ${simple.maxBitrateMbps}M -bufsize ${simple.maxBitrateMbps * 2}M`;
  if (simple.codec !== 'prores' && simple.keyframeInterval) args += ` -g ${simple.keyframeInterval}`;
  if (simple.encoder === 'software' && simple.threads) args += ` -threads:v ${simple.threads}`;
  if (simple.encoder === 'software' && simple.codec === 'h264' && simple.tune && simple.tune !== 'none') args += ` -tune ${simple.tune}`;
  if (simple.codec === 'prores' && simple.proresProfile !== undefined) args += ` -profile:v ${simple.proresProfile}`;
  if (simple.audioCodec === 'none') args += ' -an';
  else if (simple.audioCodec && simple.audioCodec !== 'copy') {
    args += ` -c:a ${simple.audioCodec}`;
    if (simple.audioCodec !== 'flac') args += ` -b:a ${simple.audioBitrateKbps ?? 192}k`;
    if (simple.audioChannels) args += ` -ac ${simple.audioChannels}`;
  }
  if (simple.copyMetadata === false) args = args.replace('-map_metadata 1', '-map_metadata -1');
  return args;
}

/** The FFmpeg video arguments a render is encoded with. */
export function resolveEncodingArgs(encoding: EncodingSettings): string {
  return encoding.mode === 'advanced' ? encoding.customArgs : simpleArgsOf(encoding.simple);
}

function validPreset(codec: SimpleCodec, encoder: Encoder, preset: unknown): preset is Preset {
  return typeof preset === 'string' && getAvailablePresets(codec, encoder).includes(preset as Preset);
}

/** Simple settings made valid: the encoder offered for the codec, a preset it has, a quality on its scale. */
function normalizeSimple(value: unknown): SimpleEncoding | null {
  if (!value || typeof value !== 'object') return null;
  const simple = value as Partial<Record<keyof SimpleEncoding, unknown>>;
  if (!SIMPLE_CODECS.includes(simple.codec as SimpleCodec)) return null;
  const codec = simple.codec as SimpleCodec;
  const encoder = getAvailableEncoders(codec).includes(simple.encoder as Encoder) ? simple.encoder as Encoder : 'software';
  const preset = validPreset(codec, encoder, simple.preset) ? simple.preset : getDefaultPreset(encoder, codec);
  const quality = clampQuality(codec, encoder, typeof simple.quality === 'number' ? simple.quality : NaN);
  const result: SimpleEncoding = { codec, encoder, preset, quality };
  if (simple.rateControl === 'quality' || simple.rateControl === 'bitrate') result.rateControl = simple.rateControl;
  const numeric = (key: 'bitrateMbps' | 'maxBitrateMbps' | 'keyframeInterval' | 'threads' | 'proresProfile' | 'audioBitrateKbps', min: number, max: number, integer = false) => {
    const v = simple[key];
    if (typeof v === 'number' && Number.isFinite(v)) result[key] = Math.min(max, Math.max(min, integer ? Math.round(v) : v));
  };
  numeric('bitrateMbps', 0.1, 1000); numeric('maxBitrateMbps', 0.1, 1000);
  numeric('keyframeInterval', 0, 1000, true); numeric('threads', 0, 256, true);
  numeric('proresProfile', 0, 5, true); numeric('audioBitrateKbps', 32, 640, true);
  if (result.rateControl === 'bitrate') result.bitrateMbps ??= 8;
  if (result.maxBitrateMbps && result.rateControl === 'bitrate') result.maxBitrateMbps = Math.max(result.maxBitrateMbps, result.bitrateMbps!);
  if (['none', 'film', 'animation', 'grain', 'stillimage', 'fastdecode', 'zerolatency'].includes(String(simple.tune))) result.tune = simple.tune as SimpleEncoding['tune'];
  if (['copy', 'aac', 'ac3', 'flac', 'none'].includes(String(simple.audioCodec))) result.audioCodec = simple.audioCodec as SimpleEncoding['audioCodec'];
  if ([0, 1, 2, 6].includes(simple.audioChannels as number)) result.audioChannels = simple.audioChannels as number;
  if (typeof simple.copyMetadata === 'boolean') result.copyMetadata = simple.copyMetadata;
  if (typeof simple.fastStart === 'boolean') result.fastStart = simple.fastStart;
  return result;
}

/** Stored encoding settings, made valid, or null when value is not encoding settings. */
export function normalizeEncodingSettings(value: unknown): EncodingSettings | null {
  if (!value || typeof value !== 'object') return null;
  const encoding = value as Partial<Record<keyof EncodingSettings, unknown>>;
  if (encoding.mode !== 'simple' && encoding.mode !== 'advanced') return null;
  const simple = normalizeSimple(encoding.simple);
  if (!simple) return null;
  const audioTracks = normalizeTrackSelection(encoding.audioTracks);
  const subtitleTracks = normalizeTrackSelection(encoding.subtitleTracks);
  if (audioTracks === null || subtitleTracks === null) return null;
  return {
    ...(audioTracks !== undefined ? { audioTracks } : {}),
    ...(subtitleTracks !== undefined ? { subtitleTracks } : {}),
    mode: encoding.mode,
    simple,
    customArgs: typeof encoding.customArgs === 'string' ? encoding.customArgs : '',
  };
}

/** A faststart flag at the end of an argument string. Renders to MP4 and MOV get it without one. */
const TRAILING_FASTSTART = /(^|\s+)-movflags\s+\+?faststart\s*$/;

/** The simple settings closest to args: its -c:v where the simple controls offer it, else the defaults. */
function closestSimple(args: string): SimpleEncoding {
  const named = simpleCodecOf(args.match(/-c:v\s+(\S+)/)?.[1] ?? '');
  const codec = named?.codec ?? DEFAULT_SIMPLE_ENCODING.codec;
  const encoder = named?.encoder ?? DEFAULT_SIMPLE_ENCODING.encoder;
  const preset = args.match(/-preset\s+(\S+)/)?.[1];
  const quality = args.match(/-(?:crf|cq|qp_i|global_quality)\s+(\d+(?:\.\d+)?)/)?.[1];
  return {
    codec,
    encoder,
    preset: validPreset(codec, encoder, preset) ? preset : getDefaultPreset(encoder, codec),
    quality: quality === undefined
      ? getRecommendedCrfRange(codec, encoder).default
      : clampQuality(codec, encoder, parseFloat(quality)),
  };
}

/**
 * The encoding settings for an argument string from before the mode was
 * stored. A string the simple controls can show (a trailing faststart flag
 * counts as standard) is simple mode; any other is advanced, encoded as it is.
 * The string is kept as the custom arguments either way.
 */
export function migrateLegacyArgs(args: string): EncodingSettings {
  const parsed = parseFfmpegArgs(args.replace(TRAILING_FASTSTART, ''));
  if (parsed.codec !== 'custom' && validPreset(parsed.codec, parsed.encoder, parsed.preset)) {
    return {
      mode: 'simple',
      simple: { codec: parsed.codec, encoder: parsed.encoder, preset: parsed.preset, quality: parsed.crf },
      customArgs: args,
    };
  }
  return { mode: 'advanced', simple: closestSimple(args), customArgs: args };
}

/**
 * The encoding settings a stored record carries: its encoding settings, its
 * legacy argument string, or both. Both are written together, so when the
 * string is not what the settings resolve to, an older version changed it and
 * the string decides; the half of the settings it does not cover is kept.
 */
export function encodingFrom(encoding: unknown, ffmpegArgs: unknown): EncodingSettings | null {
  const stored = normalizeEncodingSettings(encoding);
  if (typeof ffmpegArgs !== 'string') return stored;
  if (stored && resolveEncodingArgs(stored) === ffmpegArgs) return stored;
  const migrated = {
    ...migrateLegacyArgs(ffmpegArgs),
    ...(stored?.audioTracks !== undefined ? { audioTracks: stored.audioTracks } : {}),
    ...(stored?.subtitleTracks !== undefined ? { subtitleTracks: stored.subtitleTracks } : {}),
  };
  if (!stored) return migrated;
  return migrated.mode === 'simple'
    ? { ...migrated, customArgs: stored.customArgs || migrated.customArgs }
    : { ...migrated, simple: stored.simple };
}

/** Edit normal controls and immediately refresh their advanced argument representation. */
export function withSimpleEncoding(encoding: EncodingSettings, simple: SimpleEncoding): EncodingSettings {
  return { ...encoding, simple, customArgs: simpleArgsOf(simple) };
}

/** Enter advanced mode using the current normal settings, never an old argument draft. */
export function withEncodingMode(encoding: EncodingSettings, mode: EncodingMode): EncodingSettings {
  if (mode === encoding.mode) return encoding;
  return { ...encoding, mode, customArgs: simpleArgsOf(encoding.simple) };
}

/** A new codec, keeping the encoder where the codec offers it, with that pair's default preset and quality. */
export function simpleWithCodec(simple: SimpleEncoding, codec: SimpleCodec): SimpleEncoding {
  const encoder = getAvailableEncoders(codec).includes(simple.encoder) ? simple.encoder : 'software';
  return {
    ...simple,
    codec,
    encoder,
    preset: getDefaultPreset(encoder, codec),
    quality: getRecommendedCrfRange(codec, encoder).default,
  };
}

/** A new encoder, with its default preset and the quality pulled onto its scale. */
export function simpleWithEncoder(simple: SimpleEncoding, encoder: Encoder): SimpleEncoding {
  return {
    ...simple,
    encoder,
    preset: getDefaultPreset(encoder, simple.codec),
    quality: clampQuality(simple.codec, encoder, simple.quality),
  };
}

/**
 * Split an argument string into arguments. Spaces inside quotes do not split.
 * Quotes that open an argument are removed, as in a shell; quotes inside one
 * are kept for FFmpeg's own parsing (a filter's 'quoted' option values).
 */
export function splitArgs(text: string): string[] {
  const args: string[] = [];
  let current = '';
  let inArg = false;
  let quote: '"' | "'" | null = null;
  let keepQuote = false;
  for (const char of text) {
    if (quote) {
      if (char === quote) {
        if (keepQuote) current += char;
        quote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      keepQuote = inArg;
      if (keepQuote) current += char;
      quote = char;
      inArg = true;
    } else if (/\s/.test(char)) {
      if (inArg) args.push(current);
      current = '';
      inArg = false;
    } else {
      current += char;
      inArg = true;
    }
  }
  if (inArg) args.push(current);
  return args;
}
