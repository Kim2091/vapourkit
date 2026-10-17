import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs-extra', () => ({ ensureDir: vi.fn(async () => undefined) }));
vi.mock('7zip-min', () => ({ cmd: vi.fn(), unpack: vi.fn() }));

import * as _7z from '7zip-min';
import { extract7z, isArchiveLockedError } from './archive';

beforeEach(() => {
  vi.mocked(_7z.cmd).mockReset();
  vi.mocked(_7z.unpack).mockReset();
});

describe('extract7z', () => {
  it('unpacks, or extracts skip-existing when asked', async () => {
    vi.mocked(_7z.unpack).mockResolvedValue(undefined as never);
    vi.mocked(_7z.cmd).mockResolvedValue(undefined as never);
    await extract7z('a.7z', 'out');
    expect(_7z.unpack).toHaveBeenCalledWith('a.7z', 'out');
    await extract7z('a.7z', 'out', { skipExisting: true });
    expect(_7z.cmd).toHaveBeenCalledWith(['x', 'a.7z', '-oout', '-aos', '-y']);
  });

  it('retries a locked archive, then succeeds', async () => {
    vi.mocked(_7z.unpack)
      .mockRejectedValueOnce(new Error("Can't open as archive"))
      .mockResolvedValueOnce(undefined as never);
    const retries: number[] = [];
    await extract7z('a.7z', 'out', { retryDelayMs: 0, onLockedRetry: attempt => retries.push(attempt) });
    expect(retries).toEqual([1]);
    expect(_7z.unpack).toHaveBeenCalledTimes(2);
  });

  it('throws any other error at once, and a lock after the last attempt', async () => {
    vi.mocked(_7z.unpack).mockRejectedValue(new Error('Data error'));
    await expect(extract7z('a.7z', 'out', { retryDelayMs: 0 })).rejects.toThrow('Data error');
    expect(_7z.unpack).toHaveBeenCalledTimes(1);

    vi.mocked(_7z.unpack).mockReset().mockRejectedValue(new Error('Can not open the file as archive'));
    await expect(extract7z('a.7z', 'out', { attempts: 3, retryDelayMs: 0 })).rejects.toThrow('Can not open');
    expect(_7z.unpack).toHaveBeenCalledTimes(3);
  });

  it('recognises the lock messages', () => {
    expect(isArchiveLockedError('The process cannot access the file because it is being used by another process')).toBe(true);
    expect(isArchiveLockedError('CRC Failed')).toBe(false);
  });
});
