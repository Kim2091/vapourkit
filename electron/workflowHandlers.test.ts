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
});
