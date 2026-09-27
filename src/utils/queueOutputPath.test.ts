import { describe, it, expect } from 'vitest';
import { autoOutputPath, uniqueOutputPath } from './queueOutputPath';
import type { Filter } from '../electron.d';

const model = (modelPath: string): Filter =>
  ({ id: modelPath, enabled: true, filterType: 'aiModel', preset: 'AI Model', code: '', order: 0, modelPath });

describe('autoOutputPath', () => {
  it('names the output from the chain, or "processed" when descriptive naming is off', () => {
    const workflow = { filters: [model('C:/m/2x-AnimeSharp.onnx')], outputFormat: 'mkv' };
    expect(autoOutputPath('C:/v/ep.01.mp4', workflow, true)).toBe('C:/v/ep.01-2xanimesharp.mkv');
    expect(autoOutputPath('C:/v/ep.01.mp4', workflow, false)).toBe('C:/v/ep.01-processed.mkv');
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
    expect(uniqueOutputPath('C:\v.1\out.mp4', ['C:\v.1\out.mp4'])).toBe('C:\v.1\out-2.mp4');
  });
});
