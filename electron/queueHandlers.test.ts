import * as fs from 'fs-extra';
import * as path from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { dir, handlers, listeners } = vi.hoisted(() => {
  const nodePath = require('path') as typeof import('path');
  const nodeOs = require('os') as typeof import('os');
  return {
    dir: nodePath.join(nodeOs.tmpdir(), `vk-queue-test-${process.pid}`),
    handlers: new Map<string, (...args: any[]) => any>(),
    listeners: new Map<string, (...args: any[]) => any>(),
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: any[]) => any) => handlers.set(channel, fn),
    on: (channel: string, fn: (...args: any[]) => any) => listeners.set(channel, fn),
  },
}));
vi.mock('./constants', () => ({ PATHS: { CONFIG: dir } }));
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { registerQueueHandlers } from './queueHandlers';

const queueFile = path.join(dir, 'queue.json');
const invoke = (channel: string, ...args: any[]) => handlers.get(channel)!({}, ...args);
const saveSync = (queue: any[]) => {
  const event: { returnValue?: any } = {};
  listeners.get('save-queue-sync')!(event, queue);
  return event.returnValue;
};

describe('queue file', () => {
  beforeAll(() => registerQueueHandlers());
  beforeEach(async () => { await fs.remove(dir); await fs.ensureDir(dir); });
  afterEach(async () => { await fs.remove(dir); });

  it('keeps an unreadable queue file before anything saves over it', async () => {
    await fs.writeFile(queueFile, '[{"id": "a", "videoPath": "C:/v.mkv"');
    expect(await invoke('get-queue')).toEqual([]);
    // The renderer saves what it loaded straight away.
    expect(await invoke('save-queue', [])).toEqual({ success: true });

    const kept = (await fs.readdir(dir)).filter(name => name.startsWith('queue.unreadable-'));
    expect(kept).toHaveLength(1);
    expect(await fs.readFile(path.join(dir, kept[0]), 'utf8')).toContain('"id": "a"');
  });

  it('keeps the save made on close over a debounced save still in flight', async () => {
    await invoke('get-queue');
    const debounced = invoke('save-queue', [{ id: 'old', pad: 'x'.repeat(100000) }]);
    expect(saveSync([{ id: 'closing' }])).toEqual({ success: true });
    await debounced;
    expect(await fs.readJson(queueFile)).toEqual([{ id: 'closing' }]);
  });

  it('clears to an empty queue that a late save cannot undo', async () => {
    await invoke('get-queue');
    const late = invoke('save-queue', [{ id: 'old', pad: 'x'.repeat(100000) }]);
    await invoke('clear-queue');
    await late;
    expect(await fs.readJson(queueFile)).toEqual([]);
  });
});
