// src/utils/ffmpegConfig.ts
// Utilities for parsing and generating FFmpeg encoding arguments

export type Codec = 'h264' | 'h265' | 'av1' | 'prores' | 'custom';
export type Preset = 'ultrafast' | 'superfast' | 'veryfast' | 'faster' | 'fast' | 'medium' | 'slow' | 'slower' | 'veryslow' | 'p1' | 'p2' | 'p3' | 'p4' | 'p5' | 'p6' | 'p7' | 'quality' | 'balanced' | 'speed' | '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | '11' | '12';
export type Encoder = 'software' | 'nvidia' | 'amd' | 'intel';

export interface FfmpegConfig {
  codec: Codec;
  encoder: Encoder;
  preset: Preset;
  crf: number;
  customArgs?: string;
}

const CODEC_MAPPINGS: Record<string, Codec> = {
  'libx264': 'h264',
  'h264_nvenc': 'h264',
  'h264_amf': 'h264',
  'h264_qsv': 'h264',
  'libx265': 'h265',
  'hevc': 'h265',
  'hevc_nvenc': 'h265',
  'hevc_amf': 'h265',
  'hevc_qsv': 'h265',
  'libaom-av1': 'av1',
  'libsvtav1': 'av1',
  'av1': 'av1',
  'av1_nvenc': 'av1',
  'av1_amf': 'av1',
  'av1_qsv': 'av1',
  'prores': 'prores',
  'prores_ks': 'prores'
};

const ENCODER_MAPPINGS: Record<string, Encoder> = {
  'libx264': 'software',
  'h264_nvenc': 'nvidia',
  'h264_amf': 'amd',
  'h264_qsv': 'intel',
  'libx265': 'software',
  'hevc_nvenc': 'nvidia',
  'hevc_amf': 'amd',
  'hevc_qsv': 'intel',
  'libsvtav1': 'software',
  'av1_nvenc': 'nvidia',
  'av1_amf': 'amd',
  'av1_qsv': 'intel',
  'prores_ks': 'software'
};

const CODEC_ENCODER_TO_FFMPEG: Record<string, string> = {
  'h264-software': 'libx264',
  'h264-nvidia': 'h264_nvenc',
  'h264-amd': 'h264_amf',
  'h264-intel': 'h264_qsv',
  'h265-software': 'libx265',
  'h265-nvidia': 'hevc_nvenc',
  'h265-amd': 'hevc_amf',
  'h265-intel': 'hevc_qsv',
  'av1-software': 'libsvtav1',
  'av1-nvidia': 'av1_nvenc',
  'av1-amd': 'av1_amf',
  'av1-intel': 'av1_qsv',
  'prores-software': 'prores_ks'
};

interface QualityRange {
  min: number;
  max: number;
  default: number;
}

/**
 * Constant-quality scales, per codec+encoder pair.
 *
 * The number the slider produces is fed straight to the encoder, so each entry
 * mirrors that encoder's own scale rather than rescaling a shared 0-51/0-63
 * range onto it:
 *  - software (x264/x265/SVT-AV1) takes -crf on its native scale
 *  - NVENC takes -cq, where 0 means "automatic" rather than "lossless", so the
 *    minimum is 1
 *  - AMF takes a real quantiser; AV1 uses the 0-255 qindex scale, not 0-63
 *  - QSV takes -global_quality (ICQ), which is 1-51 for every codec
 */
const QUALITY_RANGES: Record<string, QualityRange> = {
  'h264-software': { min: 0, max: 51, default: 18 },
  'h265-software': { min: 0, max: 51, default: 20 },
  'av1-software': { min: 0, max: 63, default: 25 },

  'h264-nvidia': { min: 1, max: 51, default: 20 },
  'h265-nvidia': { min: 1, max: 51, default: 20 },
  'av1-nvidia': { min: 1, max: 63, default: 25 },

  'h264-amd': { min: 0, max: 51, default: 20 },
  'h265-amd': { min: 0, max: 51, default: 20 },
  'av1-amd': { min: 0, max: 255, default: 100 },

  'h264-intel': { min: 1, max: 51, default: 20 },
  'h265-intel': { min: 1, max: 51, default: 20 },
  'av1-intel': { min: 1, max: 51, default: 25 }
};

const FALLBACK_QUALITY_RANGE: QualityRange = { min: 0, max: 51, default: 18 };

/**
 * Clamp a quality value into the range its codec+encoder pair actually accepts
 */
export function clampQuality(codec: Codec, encoder: Encoder, value: number): number {
  const range = getRecommendedCrfRange(codec, encoder);
  if (!Number.isFinite(value)) {
    return range.default;
  }
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

/**
 * Build the rate-control arguments that put an encoder into constant-quality mode.
 *
 * Only the software encoders understand -crf. Passing it to NVENC/AMF/QSV leaves
 * the flag unconsumed (FFmpeg only warns) and the encoder runs in its default
 * bitrate-targeted mode, which is why a hardware encode used to come out at a
 * few Mbps no matter where the quality slider sat.
 */
export function getQualityArgs(codec: Codec, encoder: Encoder, quality: number): string[] {
  const value = clampQuality(codec, encoder, quality);

  switch (encoder) {
    case 'nvidia':
      // -b:v 0 lifts the default bitrate cap that would otherwise bound -cq.
      return [`-cq ${value}`, '-b:v 0'];
    case 'amd':
      // hevc_amf has no -qp_b; emitting it there would go unconsumed.
      return codec === 'h265'
        ? ['-rc cqp', `-qp_i ${value}`, `-qp_p ${value}`]
        : ['-rc cqp', `-qp_i ${value}`, `-qp_p ${value}`, `-qp_b ${value}`];
    case 'intel':
      return [`-global_quality ${value}`];
    case 'software':
    default:
      return [`-crf ${value}`];
  }
}

/**
 * Parse FFmpeg args string to extract codec, encoder, preset, and CRF
 */
export function parseFfmpegArgs(args: string): FfmpegConfig {
  // Default values
  let codec: Codec = 'h264';
  let encoder: Encoder = 'software';
  let preset: Preset = 'medium';
  let crf = 18;

  // Parse codec
  const codecMatch = args.match(/-c:v\s+(\S+)/);
  if (codecMatch) {
    const codecValue = codecMatch[1];
    codec = CODEC_MAPPINGS[codecValue] || 'custom';
    encoder = ENCODER_MAPPINGS[codecValue] || 'software';
  }

  // Set default preset based on encoder and codec
  preset = getDefaultPreset(encoder, codec);

  // Parse preset
  const presetMatch = args.match(/-preset\s+(\S+)/);
  if (presetMatch) {
    preset = presetMatch[1] as Preset;
  }

  // Parse the quality value. Which flag carries it depends on the encoder, so
  // accept any of them and fall back to this pair's default.
  crf = getRecommendedCrfRange(codec, encoder).default;
  const qualityMatch =
    args.match(/-crf\s+(\d+)/) ??
    args.match(/-cq\s+(\d+)/) ??
    args.match(/-qp_i\s+(\d+)/) ??
    args.match(/-global_quality\s+(\d+)/);
  if (qualityMatch) {
    crf = clampQuality(codec, encoder, parseInt(qualityMatch[1], 10));
  }

  // If it's a custom codec or has additional flags, mark as custom
  if (codec === 'custom' || hasCustomFlags(args)) {
    return {
      codec: 'custom',
      encoder: 'software',
      preset,
      crf,
      customArgs: args
    };
  }

  return { codec, encoder, preset, crf };
}

/**
 * Check if args contain custom flags beyond the basic codec/preset/crf
 */
function hasCustomFlags(args: string): boolean {
  // Remove known flags
  const cleaned = args
    .replace(/-c:v\s+\S+/, '')
    .replace(/-preset\s+\S+/, '')
    .replace(/-crf\s+\d+/, '')
    // Hardware rate-control flags this module generates itself. -b:v is only
    // matched at 0 so a real bitrate target still counts as custom.
    .replace(/-cq\s+\d+/, '')
    .replace(/-b:v\s+0(?!\S)/, '')
    .replace(/-rc\s+cqp/, '')
    .replace(/-qp_i\s+\d+/, '')
    .replace(/-qp_p\s+\d+/, '')
    .replace(/-qp_b\s+\d+/, '')
    .replace(/-global_quality\s+\d+/, '')
    .replace(/-vf\s+\S+/, '')
    .replace(/-map_metadata\s+\d+/, '')
    .trim();
  
  // If there's anything left beyond whitespace, it's custom
  return cleaned.length > 0;
}

/**
 * Generate FFmpeg args string from config
 */
export function generateFfmpegArgs(config: FfmpegConfig): string {
  if (config.codec === 'custom' && config.customArgs) {
    return config.customArgs;
  }

  const encoderKey = `${config.codec}-${config.encoder}`;
  const codecFlag = CODEC_ENCODER_TO_FFMPEG[encoderKey];
  const parts: string[] = [];

  // Add codec
  if (codecFlag) {
    parts.push(`-c:v ${codecFlag}`);
  }

  // Add preset (not applicable to ProRes)
  if (config.codec !== 'prores') {
    parts.push(`-preset ${config.preset}`);
  }

  // Add the quality control (not applicable to ProRes).
  // Each encoder family names this differently, and the hardware encoders ignore
  // -crf outright, so emitting it there silently falls back to their default
  // bitrate-targeted rate control.
  if (config.codec !== 'prores') {
    parts.push(...getQualityArgs(config.codec, config.encoder, config.crf));
  }

  // Add video filter for color parameters
  parts.push('-vf setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709');

  // Always add metadata mapping
  parts.push('-map_metadata 1');

  return parts.join(' ');
}

/**
 * Get the constant-quality range for a codec on a given encoder.
 *
 * The encoder matters: NVENC treats 0 as "automatic", and AMF's AV1 quantiser
 * runs 0-255 rather than 0-63, so a single per-codec range would hand some
 * encoders values they cannot act on.
 */
export function getRecommendedCrfRange(
  codec: Codec,
  encoder: Encoder = 'software'
): { min: number; max: number; default: number } {
  return QUALITY_RANGES[`${codec}-${encoder}`]
    ?? QUALITY_RANGES[`${codec}-software`]
    ?? FALLBACK_QUALITY_RANGE;
}

/**
 * Get the name of the quality flag an encoder actually uses, for display
 */
export function getQualityLabel(encoder: Encoder): string {
  switch (encoder) {
    case 'nvidia':
      return 'CQ';
    case 'amd':
      return 'QP';
    case 'intel':
      return 'ICQ';
    default:
      return 'CRF';
  }
}

/**
 * Get available presets for an encoder
 */
export function getAvailablePresets(codec: Codec, encoder: Encoder): Preset[] {
  if (codec === 'prores') {
    return ['medium']; // ProRes doesn't use presets
  }
  
  // Hardware encoders use different preset systems
  if (encoder === 'nvidia') {
    // NVENC uses p1-p7 (p1=fastest, p7=slowest/best quality)
    return ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
  }
  
  if (encoder === 'amd') {
    // AMF uses quality/balanced/speed
    return ['speed', 'balanced', 'quality'];
  }
  
  if (encoder === 'intel') {
    // QSV uses veryfast/faster/fast/medium/slow/slower/veryslow
    return ['veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];
  }
  
  // SVT-AV1 uses numeric presets 0-12 (0=slowest/best, 12=fastest)
  // Preset 13 is only for debugging, so we exclude it
  if (codec === 'av1') {
    return ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
  }
  
  // Software encoders (x264, x265) use standard presets
  return ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];
}

/**
 * Get default preset for an encoder
 */
export function getDefaultPreset(encoder: Encoder, codec?: Codec): Preset {
  if (encoder === 'software') {
    // SVT-AV1 uses numeric presets, default to 8 (balanced speed/quality)
    if (codec === 'av1') {
      return '8';
    }
    // x264/x265: use medium for balanced speed/quality
    return 'medium';
  }
  
  // Hardware encoders: default to slowest/best quality since hardware is fast
  if (encoder === 'nvidia') {
    return 'p7'; // Slowest/best quality
  }
  
  if (encoder === 'amd') {
    return 'quality'; // Best quality
  }
  
  if (encoder === 'intel') {
    return 'veryslow'; // Slowest/best quality
  }
  
  return 'medium';
}

/**
 * Get display name for preset
 */
export function getPresetDisplayName(preset: Preset): string {
  // NVENC presets
  if (preset.startsWith('p')) {
    const level = parseInt(preset.substring(1));
    if (level <= 2) return 'Fastest';
    if (level <= 4) return 'Balanced';
    return 'Best Quality';
  }
  
  // SVT-AV1 numeric presets (0=slowest/best, 12=fastest)
  const numericPreset = parseInt(preset);
  if (!isNaN(numericPreset) && numericPreset >= 0 && numericPreset <= 12) {
    if (numericPreset >= 10) return 'Fastest';
    if (numericPreset >= 7) return 'Fast Encode';
    if (numericPreset >= 5) return 'Balanced';
    if (numericPreset >= 3) return 'Slow Encode';
    return 'Best Quality';
  }
  
  // AMF presets
  if (preset === 'speed') return 'Fast Encode';
  if (preset === 'balanced') return 'Balanced';
  if (preset === 'quality') return 'Best Quality';
  
  // Standard x264/x265/QSV presets
  if (preset === 'ultrafast' || preset === 'superfast' || preset === 'veryfast') return 'Fast Encode';
  if (preset === 'faster' || preset === 'fast') return 'Fast Encode';
  if (preset === 'medium') return 'Balanced';
  return 'Best Quality';
}

/**
 * Validate if codec supports CRF
 */
export function supportsCrf(codec: Codec): boolean {
  return codec !== 'prores' && codec !== 'custom';
}

/**
 * Validate if codec supports preset
 */
export function supportsPreset(codec: Codec): boolean {
  return codec !== 'prores' && codec !== 'custom';
}

/**
 * Get available encoders for a codec
 */
export function getAvailableEncoders(codec: Codec): Encoder[] {
  switch (codec) {
    case 'h264':
    case 'h265':
    case 'av1':
      return ['software', 'nvidia', 'amd', 'intel'];
    case 'prores':
      return ['software'];
    default:
      return ['software'];
  }
}

/**
 * Get encoder display name
 */
export function getEncoderDisplayName(encoder: Encoder): string {
  switch (encoder) {
    case 'software':
      return 'CPU (Software)';
    case 'nvidia':
      return 'NVIDIA (NVENC)';
    case 'amd':
      return 'AMD (AMF)';
    case 'intel':
      return 'Intel (QSV)';
  }
}

/**
 * Get short encoder display name for badges
 */
export function getEncoderShortName(encoder: Encoder): string {
  switch (encoder) {
    case 'software':
      return 'CPU';
    case 'nvidia':
      return 'NVIDIA';
    case 'amd':
      return 'AMD';
    case 'intel':
      return 'Intel';
  }
}
