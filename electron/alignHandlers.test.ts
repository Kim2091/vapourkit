import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('./constants', () => ({ PATHS: { CONFIG: '/c', PYTHON: '/p', VS: '/v' } }));
vi.mock('./utils', () => ({ setupVSEnvironment: () => ({}) }));

import { AlignOutputReader } from './alignHandlers';
import { samePath } from './chainGraph';

describe('reading the aligner', () => {
  it('reports progress, passes chatter to the log, and keeps the result', () => {
    const progress: [number, string][] = [];
    const other: string[] = [];
    const reader = new AlignOutputReader((p, m) => progress.push([p, m]), line => other.push(line));

    reader.push('{"progress": 0.5, "message": "Matching 20 of 40 moments"}\nPlugin x is using API3\n{"res');
    reader.push('ult": {"speed": 1.0, "sections": [{"from": 0, "offset": 0.03}], "matched": 25, "usable": 25, "samples": 40}}\n');

    expect(progress).toEqual([[0.5, 'Matching 20 of 40 moments']]);
    expect(other).toEqual(['Plugin x is using API3']);
    expect(reader.result?.sections).toEqual([{ from: 0, offset: 0.03 }]);
    expect(reader.error).toBeNull();
  });

  it('keeps the plain-language error', () => {
    const reader = new AlignOutputReader(() => {});
    reader.push('{"error": "Only 2 moments matched clearly"}\n');
    expect(reader.error).toBe('Only 2 moments matched clearly');
    expect(reader.result).toBeNull();
  });

  it('clamps progress into 0..1', () => {
    const seen: number[] = [];
    const reader = new AlignOutputReader(p => seen.push(p));
    reader.push('{"progress": 1.7}\n{"progress": -1}\n');
    expect(seen).toEqual([1, 0]);
  });
});

describe('which video an alignment belongs to', () => {
  it('compares Windows paths without case or slash style, POSIX ones exactly', () => {
    expect(samePath('D:\\Video\\B1_t01.mkv', 'd:/video/b1_t01.MKV')).toBe(true);
    expect(samePath('/home/k/a.mkv', '/home/k/A.mkv')).toBe(false);
    expect(samePath(undefined, 'a')).toBe(false);
  });
});
