import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./constants', () => ({ PATHS: { CONFIG: '' } }));
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./utils', () => ({ getBundledBasePath: () => '' }));
vi.mock('./rocmEnvironment', () => ({ DEFAULT_ROCM_SETTING: 'auto', setRocmSetting: vi.fn() }));

import { DEFAULT_FFMPEG_ARGS } from './configManager';
import {
  DEFAULT_ENCODING,
  encodingFrom,
  migrateLegacyArgs,
  normalizeEncodingSettings,
  resolveEncodingArgs,
  simpleArgsOf,
  simpleWithCodec,
  splitArgs,
  withEncodingMode,
  type EncodingSettings,
} from './encodingSettings';
import { parseFfmpegArgs } from './ffmpegConfig';

const STOCK_ARGS: string = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'include', 'stock-app-config.json'), 'utf8'),
).ffmpegArgs;
/** The stock arguments with the faststart flag, as older installs have them. */
const OLD_STOCK_ARGS = `${DEFAULT_FFMPEG_ARGS} -movflags +faststart`;

describe('stock and default arguments', () => {
  it('parse as simple settings', () => {
    expect(parseFfmpegArgs(STOCK_ARGS).codec).toBe('h264');
    expect(parseFfmpegArgs(DEFAULT_FFMPEG_ARGS).codec).toBe('h264');
  });

  it('are what the default simple settings generate', () => {
    expect(STOCK_ARGS).toBe(DEFAULT_FFMPEG_ARGS);
    expect(resolveEncodingArgs(DEFAULT_ENCODING)).toBe(DEFAULT_FFMPEG_ARGS);
  });
});

describe('migrating an argument string', () => {
  it('opens the old stock string, with its trailing faststart, in simple mode', () => {
    const encoding = migrateLegacyArgs(OLD_STOCK_ARGS);
    expect(encoding.mode).toBe('simple');
    expect(encoding.simple).toEqual({ codec: 'h264', encoder: 'software', preset: 'medium', quality: 18 });
    expect(encoding.customArgs).toBe(OLD_STOCK_ARGS);
  });

  it('opens the default in simple mode, encoding the same arguments', () => {
    const encoding = migrateLegacyArgs(DEFAULT_FFMPEG_ARGS);
    expect(encoding.mode).toBe('simple');
    expect(resolveEncodingArgs(encoding)).toBe(DEFAULT_FFMPEG_ARGS);
  });

  it('keeps the codec of generated hardware arguments', () => {
    const encoding = migrateLegacyArgs('-c:v hevc_nvenc -preset p6 -cq 24 -b:v 0 -vf setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709 -map_metadata 1');
    expect(encoding).toMatchObject({ mode: 'simple', simple: { codec: 'h265', encoder: 'nvidia', preset: 'p6', quality: 24 } });
  });

  it('opens the older generated form, without colour tags, in simple mode', () => {
    expect(migrateLegacyArgs('-c:v libx264 -preset slow -crf 16 -map_metadata 1').simple)
      .toEqual({ codec: 'h264', encoder: 'software', preset: 'slow', quality: 16 });
    expect(migrateLegacyArgs('-c:v libx264 -preset medium -crf 18 -map_metadata 1 -movflags +faststart').mode).toBe('simple');
  });

  it('keeps a user -vf or -map_metadata in advanced mode, with the codec it names', () => {
    for (const args of [
      '-c:v libx265 -preset slow -crf 20 -vf scale=1920:-2 -map_metadata 1',
      '-c:v libx265 -preset slow -crf 20 -map_metadata 0',
    ]) {
      const encoding = migrateLegacyArgs(args);
      expect(encoding.mode).toBe('advanced');
      expect(resolveEncodingArgs(encoding)).toBe(args);
      expect(encoding.simple).toEqual({ codec: 'h265', encoder: 'software', preset: 'slow', quality: 20 });
    }
  });

  it('keeps hand-typed arguments the simple controls cannot show in advanced mode', () => {
    for (const args of [
      '-c:v libx264 -preset medium -crf 18 -crf 20',
      '-c:v libx264 -preset medium -crf 18.5',
      '-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p10le',
      '-c:v libx264 -preset medium -crf 18 -tune film',
      '-c:v libx264 -profile:v high -crf 18',
      '-c:v libx264 -preset p7 -crf 18',
      '-c:v rawvideo',
    ]) {
      const encoding = migrateLegacyArgs(args);
      expect(encoding.mode, args).toBe('advanced');
      expect(resolveEncodingArgs(encoding)).toBe(args);
    }
  });

  it('takes the advanced simple settings from -c:v rather than H.264 defaults', () => {
    expect(migrateLegacyArgs('-c:v av1_nvenc -cq 30 -rc-lookahead 32').simple)
      .toEqual({ codec: 'av1', encoder: 'nvidia', preset: 'p7', quality: 30 });
    expect(migrateLegacyArgs('-c:v prores_ks -profile:v 3').simple)
      .toMatchObject({ codec: 'prores', encoder: 'software' });
    expect(migrateLegacyArgs('-c:v libvpx-vp9 -crf 30 -b:v 0').simple)
      .toMatchObject({ codec: 'h264', encoder: 'software' });
  });
});

describe('encodingFrom', () => {
  const advanced: EncodingSettings = { ...DEFAULT_ENCODING, mode: 'advanced', customArgs: '-c:v libx264 -crf 18' };

  it('keeps stored settings whose arguments match', () => {
    expect(encodingFrom(advanced, '-c:v libx264 -crf 18')).toEqual(advanced);
    expect(encodingFrom(advanced, undefined)).toEqual(advanced);
  });

  it('migrates a record with only the argument string', () => {
    expect(encodingFrom(undefined, OLD_STOCK_ARGS)?.mode).toBe('simple');
    expect(encodingFrom(undefined, undefined)).toBeNull();
  });

  it('follows a string an older version changed, keeping the other half', () => {
    const simple = encodingFrom(advanced, '-c:v libx265 -preset fast -crf 22');
    expect(simple).toEqual({ mode: 'simple', simple: { codec: 'h265', encoder: 'software', preset: 'fast', quality: 22 }, customArgs: advanced.customArgs });

    const stored: EncodingSettings = { ...DEFAULT_ENCODING, simple: { codec: 'av1', encoder: 'software', preset: '6', quality: 30 } };
    const custom = encodingFrom(stored, '-c:v libx264 -tune film');
    expect(custom).toEqual({ mode: 'advanced', simple: stored.simple, customArgs: '-c:v libx264 -tune film' });
  });

  it('makes stored settings valid', () => {
    expect(normalizeEncodingSettings({ mode: 'simple', simple: { codec: 'h264', encoder: 'nvidia', preset: 'medium', quality: 0 }, customArgs: 5 }))
      .toEqual({ mode: 'simple', simple: { codec: 'h264', encoder: 'nvidia', preset: 'p7', quality: 1 }, customArgs: '' });
    expect(normalizeEncodingSettings({ mode: 'custom', simple: DEFAULT_ENCODING.simple, customArgs: '' })).toBeNull();
    expect(normalizeEncodingSettings({ mode: 'simple', simple: { codec: 'custom' }, customArgs: '' })).toBeNull();
  });
});

describe('switching modes', () => {
  it('keeps the advanced arguments through simple edits, and the simple settings through advanced ones', () => {
    // Leaving advanced mode used to regenerate the arguments, and coming back
    // wrote stale stored arguments over the current ones.
    let encoding: EncodingSettings = { ...DEFAULT_ENCODING, mode: 'advanced', customArgs: '-c:v libx264 -crf 18 -tune film' };
    encoding = withEncodingMode(encoding, 'simple');
    encoding = { ...encoding, simple: simpleWithCodec(encoding.simple, 'h265') };
    expect(resolveEncodingArgs(encoding)).toContain('libx265');
    encoding = withEncodingMode(encoding, 'advanced');
    expect(resolveEncodingArgs(encoding)).toBe('-c:v libx264 -crf 18 -tune film');
    encoding = { ...encoding, customArgs: '-c:v libx264 -crf 12' };
    encoding = withEncodingMode(encoding, 'simple');
    expect(encoding.simple.codec).toBe('h265');
    expect(encoding.customArgs).toBe('-c:v libx264 -crf 12');
  });

  it('stays advanced when the typed arguments are ones the simple controls could show', () => {
    const encoding: EncodingSettings = { ...DEFAULT_ENCODING, mode: 'advanced', customArgs: '-c:v libx264 -preset slow -crf 20' };
    expect(encoding.mode).toBe('advanced');
    expect(resolveEncodingArgs(encoding)).toBe('-c:v libx264 -preset slow -crf 20');
  });

  it('starts empty advanced arguments from the simple settings', () => {
    const simple = { codec: 'av1', encoder: 'software', preset: '6', quality: 28 } as const;
    const encoding = withEncodingMode({ mode: 'simple', simple, customArgs: '' }, 'advanced');
    expect(encoding.customArgs).toBe(simpleArgsOf(simple));
    expect(withEncodingMode({ mode: 'simple', simple, customArgs: '-c:v x' }, 'advanced').customArgs).toBe('-c:v x');
  });
});

describe('splitArgs', () => {
  it('splits on whitespace', () => {
    expect(splitArgs('  -c:v libx264\t-crf  18 \n')).toEqual(['-c:v', 'libx264', '-crf', '18']);
    expect(splitArgs('')).toEqual([]);
  });

  it('keeps a quoted value with spaces as one argument, without its quotes', () => {
    expect(splitArgs('-metadata "title=My Video" -vf \'scale=1280:-2, unsharp\''))
      .toEqual(['-metadata', 'title=My Video', '-vf', 'scale=1280:-2, unsharp']);
    expect(splitArgs('-metadata title= -empty ""')).toEqual(['-metadata', 'title=', '-empty', '']);
  });

  it('keeps quotes inside an argument for FFmpeg to parse', () => {
    expect(splitArgs("-vf drawtext=text='Hello world':x=10 -crf 18"))
      .toEqual(['-vf', "drawtext=text='Hello world':x=10", '-crf', '18']);
    expect(splitArgs("-vf scale='min(1280,iw)':-2")).toEqual(['-vf', "scale='min(1280,iw)':-2"]);
  });
});
