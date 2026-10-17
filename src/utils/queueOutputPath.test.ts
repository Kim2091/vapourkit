import { describe, it, expect } from 'vitest';
import {
  isAutoOutputPath,
  newQueueItems,
  outputPathFor,
  uniqueOutputPath,
  withExtension,
  withItemWorkflow,
  type QueueEntry,
} from './queueOutputPath';
import { projectOutputOverride, type PreQueueWorkflow } from './projectSnapshot';
import type { Filter, QueueItem } from '../electron.d';

const model = (modelPath: string): Filter =>
  ({ id: modelPath, enabled: true, filterType: 'aiModel', preset: 'AI Model', code: '', order: 0, modelPath });

const beside = { defaultOutputFolder: null, descriptive: true };
const inFolder = { defaultOutputFolder: 'D:\\out', descriptive: true };

const workflow = (filters: Filter[] = [model('C:/m/2x-AnimeSharp.onnx')], outputFormat = 'mkv'): QueueItem['workflow'] => ({
  selectedModel: null,
  filters,
  ffmpegArgs: '',
  processingFormat: 'vs.YUV420P8',
  outputFormat,
  videoCompareArgs: '-W',
  defaultBackend: 'tensorrt',
  numStreams: 2,
});

const entry = (id: string, outputPath: string, extra: Partial<QueueEntry> = {}): QueueEntry => ({
  id,
  videoPath: 'C:\\v\\ep.mp4',
  videoName: 'ep.mp4',
  outputPath,
  status: 'pending',
  addedAt: '',
  workflow: workflow(),
  ...extra,
});

describe('outputPathFor', () => {
  it('names the output from the chain, or "processed" when descriptive naming is off', () => {
    const wf = { filters: [model('C:/m/2x-AnimeSharp.onnx')], outputFormat: 'mkv' };
    expect(outputPathFor('C:/v/ep.01.mp4', wf, beside)).toBe('C:/v/ep.01-2xanimesharp.mkv');
    expect(outputPathFor('C:/v/ep.01.mp4', wf, { ...beside, descriptive: false })).toBe('C:/v/ep.01-processed.mkv');
  });

  it('puts the output in the default output folder when there is one', () => {
    const wf = { filters: [], outputFormat: 'mp4' };
    expect(outputPathFor('C:\\v\\ep.01.mkv', wf, inFolder)).toBe('D:\\out\\ep.01-processed.mp4');
    expect(outputPathFor('C:/v/ep.mkv', wf, { ...inFolder, defaultOutputFolder: '/srv/out/' })).toBe('/srv/out/ep-processed.mp4');
  });

  it('mentions the output resolution and frame rate once they are known', () => {
    const wf = { filters: [model('C:/m/2x-AnimeSharp.onnx')], outputFormat: 'mkv' };
    const video = { path: 'C:/v/ep.mp4', resolution: '1920x1080', outputResolution: '3840x2160', fps: 24, outputFps: 48 };
    expect(outputPathFor(video, wf, beside)).toBe('C:/v/ep-2xanimesharp_2160p_48fps.mkv');
  });

  it('keeps a dotted folder name when the file has no extension', () => {
    expect(outputPathFor('C:\\v.1\\clip', { filters: [], outputFormat: 'mkv' }, beside)).toBe('C:\\v.1\\clip-processed.mkv');
  });
});

describe('withExtension', () => {
  it('swaps or adds the extension', () => {
    expect(withExtension('C:\\v\\out.mp4', 'mkv')).toBe('C:\\v\\out.mkv');
    expect(withExtension('C:\\v.1\\out', 'mkv')).toBe('C:\\v.1\\out.mkv');
  });
});

describe('uniqueOutputPath', () => {
  it('keeps a path nobody else writes to', () => {
    expect(uniqueOutputPath('C:/v/a-x.mkv', ['C:/v/b-x.mkv'])).toBe('C:/v/a-x.mkv');
  });

  it('numbers a taken path before its extension, case-insensitively', () => {
    expect(uniqueOutputPath('C:/v/a-x.mkv', ['c:/V/A-X.mkv', 'C:/v/a-x-2.mkv'])).toBe('C:/v/a-x-3.mkv');
  });

  it('handles dots in folder names and paths without an extension', () => {
    expect(uniqueOutputPath('C:/v.1/out', ['C:/v.1/out'])).toBe('C:/v.1/out-2');
    expect(uniqueOutputPath('C:\\v.1\\out.mp4', ['C:\\v.1\\out.mp4'])).toBe('C:\\v.1\\out-2.mp4');
  });
});

describe('isAutoOutputPath', () => {
  it('follows the flag when the item has one', () => {
    expect(isAutoOutputPath(entry('a', 'C:\\anything.mkv', { customOutputPath: false }), beside)).toBe(true);
    expect(isAutoOutputPath(entry('a', 'C:\\v\\ep-2xanimesharp.mkv', { customOutputPath: true }), beside)).toBe(false);
  });

  it('recognises an older item named in the default output folder', () => {
    expect(isAutoOutputPath(entry('a', 'D:\\out\\ep-2xanimesharp.mkv'), inFolder)).toBe(true);
  });

  it('recognises an older item named beside its source, and a numbered duplicate', () => {
    expect(isAutoOutputPath(entry('a', 'C:\\v\\ep-2xanimesharp.mkv'), inFolder)).toBe(true);
    expect(isAutoOutputPath(entry('a', 'C:\\v\\ep-2xanimesharp-3.mkv'), beside)).toBe(true);
  });

  it('treats any other name on an older item as chosen', () => {
    expect(isAutoOutputPath(entry('a', 'C:\\v\\my render.mkv'), inFolder)).toBe(false);
  });
});

describe('withItemWorkflow', () => {
  const sharp = [model('C:/m/1x-Sharp.onnx')];

  it('renames an automatically named item to follow its chain, clear of other items', () => {
    const queue = [
      entry('a', 'D:\\out\\ep-2xanimesharp.mkv'),
      entry('b', 'D:\\out\\ep-2xanimesharp-2.mkv'),
      entry('c', 'D:\\out\\ep-1xsharp.mkv', { customOutputPath: false, workflow: workflow(sharp) }),
    ];
    const next = withItemWorkflow(queue, 'b', { filters: sharp }, inFolder);
    expect(next[1].outputPath).toBe('D:\\out\\ep-1xsharp-2.mkv');
    expect(next[1].customOutputPath).toBe(false);
    expect(next[1].workflow.filters).toEqual(sharp);
    expect(next[0]).toBe(queue[0]);
  });

  it('keeps a chosen path, apart from a new output format\'s extension', () => {
    const queue = [entry('a', 'E:\\keep\\mine.mkv', { customOutputPath: true })];
    expect(withItemWorkflow(queue, 'a', { filters: sharp }, inFolder)[0].outputPath).toBe('E:\\keep\\mine.mkv');
    expect(withItemWorkflow(queue, 'a', { outputFormat: 'mp4' }, inFolder)[0].outputPath).toBe('E:\\keep\\mine.mp4');
  });

  it('leaves an item that has started alone', () => {
    const queue = [entry('a', 'C:\\v\\ep-2xanimesharp.mkv', { status: 'processing' })];
    expect(withItemWorkflow(queue, 'a', { filters: sharp }, beside)).toEqual(queue);
  });
});

describe('newQueueItems', () => {
  it('names each new video automatically, clear of files other items write', () => {
    const queue = [entry('a', 'D:\\out\\ep-2xanimesharp.mkv', { status: 'completed' })];
    const { items, skipped } = newQueueItems(queue, ['C:\\v\\ep.mp4', 'C:/w/other.mov'], workflow(), inFolder);
    expect(skipped).toBe(0);
    expect(items.map(item => item.outputPath)).toEqual(['D:\\out\\ep-2xanimesharp-2.mkv', 'D:\\out\\other-2xanimesharp.mkv']);
    expect(items.map(item => item.videoName)).toEqual(['ep.mp4', 'other.mov']);
    expect(items.every(item => item.customOutputPath === false)).toBe(true);
  });

  it('skips a video already waiting', () => {
    const { items, skipped } = newQueueItems([entry('a', 'x.mkv')], ['c:\\V\\EP.mp4'], workflow(), beside);
    expect(items).toEqual([]);
    expect(skipped).toBe(1);
  });

  it('keeps the path the window shows, and whether the user chose it', () => {
    const chosen = newQueueItems([], ['C:\\v\\ep.mp4'], workflow(), beside, { path: 'E:\\mine.mkv', custom: true }).items[0];
    expect(chosen.outputPath).toBe('E:\\mine.mkv');
    expect(chosen.customOutputPath).toBe(true);
    const named = newQueueItems([], ['C:\\v\\ep.mp4'], workflow(), beside, { path: 'C:\\v\\ep-2xanimesharp_2160p.mkv', custom: false }).items[0];
    expect(named.outputPath).toBe('C:\\v\\ep-2xanimesharp_2160p.mkv');
    expect(named.customOutputPath).toBe(false);
  });

  it('copies the workflow rather than sharing it', () => {
    const wf = workflow();
    const [item] = newQueueItems([], ['C:\\v\\ep.mp4'], wf, beside).items;
    expect(item.workflow.filters).not.toBe(wf.filters);
    expect(item.workflow.filters).toEqual(wf.filters);
  });
});

describe('projectOutputOverride', () => {
  const snapshot = (extra: Partial<PreQueueWorkflow>): PreQueueWorkflow => ({
    videoPath: 'C:\\v\\ep.mp4',
    outputPath: null,
    selectedModel: null,
    filters: [model('C:/m/2x-AnimeSharp.onnx')],
    outputFormat: 'mkv',
    defaultBackend: 'tensorrt',
    numStreams: 2,
    segment: { enabled: false, startFrame: 0, endFrame: -1 },
    ...extra,
  });
  const video = { path: 'C:\\v\\ep.mp4' };

  it('uses the kept choice', () => {
    expect(projectOutputOverride(snapshot({ outputPath: 'C:\\v\\ep-2xanimesharp.mkv', outputPathOverride: 'E:\\x.mkv' }), video, beside)).toBe('E:\\x.mkv');
    expect(projectOutputOverride(snapshot({ outputPath: 'E:\\x.mkv', outputPathOverride: null }), video, beside)).toBeNull();
  });

  it('reads an older snapshot\'s path as chosen only when it is not the automatic name', () => {
    expect(projectOutputOverride(snapshot({ outputPath: 'C:\\v\\ep-2xanimesharp.mkv' }), video, beside)).toBeNull();
    expect(projectOutputOverride(snapshot({ outputPath: 'E:\\mine.mkv' }), video, beside)).toBe('E:\\mine.mkv');
  });
});
