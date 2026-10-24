import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => handlers.set(channel, fn) },
}));
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { registerWorkflowHandlers } from './workflowHandlers';

const file = path.join(os.tmpdir(), `vk-workflow-test-${process.pid}.vkworkflow`);
const invoke = (channel: string, ...args: any[]) => handlers.get(channel)!({}, ...args);

const encodingSettings = {
  ffmpegArgs: '-c:v libx264 -crf 18',
  processingFormat: 'vs.YUV420P10',
  outputFormat: 'mkv',
  videoCompareArgs: '-W',
  numStreams: 2,
  segment: { enabled: false, startFrame: 0, endFrame: -1 },
};

describe('workflow encoding settings', () => {
  beforeAll(() => registerWorkflowHandlers());
  afterEach(async () => { await fs.remove(file); });

  it('carries the default backend through export and import', async () => {
    const workflow = { name: 'w', version: '1.0', filters: [], encodingSettings: { ...encodingSettings, defaultBackend: 'directml' } };
    expect(await invoke('export-workflow', workflow, file)).toEqual({ success: true });
    const imported = await invoke('import-workflow', file);
    expect(imported.workflow.encodingSettings.defaultBackend).toBe('directml');
  });

  it('imports a workflow written without one', async () => {
    const workflow = { name: 'w', version: '1.0', filters: [], encodingSettings };
    await invoke('export-workflow', workflow, file);
    const imported = await invoke('import-workflow', file);
    expect(imported.workflow.encodingSettings.defaultBackend).toBeUndefined();
  });

  it('writes the mode, both halves, and the arguments older versions read', async () => {
    const encoding = {
      mode: 'advanced',
      simple: { codec: 'h265', encoder: 'nvidia', preset: 'p5', quality: 24 },
      customArgs: '-c:v libx264 -crf 18 -metadata "title=A B"',
    };
    const workflow = {
      name: 'w', version: '1.0', filters: [],
      encodingSettings: { ...encodingSettings, encoding, ffmpegArgs: encoding.customArgs },
    };
    await invoke('export-workflow', workflow, file);
    const written = require('@iarna/toml').parse(await fs.readFile(file, 'utf8')).encoding_settings;
    expect(written).toMatchObject({
      ffmpeg_args: encoding.customArgs,
      encoding_mode: 'advanced',
      custom_args: encoding.customArgs,
      simple_encoding: encoding.simple,
    });
    const imported = await invoke('import-workflow', file);
    expect(imported.workflow.encodingSettings.encoding).toEqual(encoding);
    expect(imported.workflow.encodingSettings.ffmpegArgs).toBe(encoding.customArgs);
  });

  it('migrates a file with only ffmpeg_args', async () => {
    const oldFile = (args: string) => [
      'filters = []', '[workflow]', 'name = "old"', 'version = "1.0"', '',
      '[encoding_settings]', `ffmpeg_args = "${args}"`, '',
    ].join('\n');
    await fs.writeFile(file, oldFile('-c:v libx264 -preset medium -crf 18 -vf setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709 -map_metadata 1 -movflags +faststart'));
    const imported = await invoke('import-workflow', file);
    expect(imported.workflow.encodingSettings.encoding).toMatchObject({ mode: 'simple', simple: { codec: 'h264', quality: 18 } });

    await fs.writeFile(file, oldFile('-c:v libx265 -x265-params aq-mode=3'));
    const custom = await invoke('import-workflow', file);
    expect(custom.workflow.encodingSettings.encoding)
      .toMatchObject({ mode: 'advanced', simple: { codec: 'h265' }, customArgs: '-c:v libx265 -x265-params aq-mode=3' });
  });
});
