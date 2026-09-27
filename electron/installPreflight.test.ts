import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  CORE_SETUP_REQUIRED_BYTES,
  LOW_SPACE_MARGIN_BYTES,
  MAX_DATA_DIR_LENGTH,
  MAX_TEMP_DIR_LENGTH,
  PLUGIN_INSTALL_REQUIRED_BYTES,
  freeBytes,
  isProtectedLocation,
  prunePipCache,
  runInstallPreflight,
} from './installPreflight';

const GB = 1024 ** 3;
const onWindows = process.platform === 'win32';

let root: string;

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vk-preflight-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.promises.rm(root, { recursive: true, force: true });
});

/** statfs answering `free` bytes for every path, recording what it was asked about. */
function stubFreeSpace(free: number | ((dir: string) => number)) {
  return vi.spyOn(fs.promises, 'statfs').mockImplementation((async (dir: fs.PathLike) => {
    const bytes = typeof free === 'function' ? free(String(dir)) : free;
    return { bavail: bytes / 4096, bsize: 4096 } as fs.StatsFs;
  }) as typeof fs.promises.statfs);
}

describe('freeBytes', () => {
  it('asks about the nearest existing ancestor of a folder that does not exist yet', async () => {
    const statfs = stubFreeSpace(10 * GB);
    expect(await freeBytes(path.join(root, 'data', 'deeper', 'still'))).toBe(10 * GB);
    expect(statfs).toHaveBeenCalledWith(root);
  });

  it('reads the real volume when not stubbed', async () => {
    const free = await freeBytes(root);
    expect(free).not.toBeNull();
    expect(free!).toBeGreaterThan(0);
  });

  it('answers null when free space cannot be read', async () => {
    vi.spyOn(fs.promises, 'statfs').mockRejectedValue(new Error('nope'));
    expect(await freeBytes(root)).toBeNull();
  });
});

describe('runInstallPreflight disk space', () => {
  const requiredBytes = 10 * GB;
  const requiredTempBytes = 4 * GB;

  it('needs the sum when the data folder and temp share a volume', async () => {
    // Enough for either figure alone, not for both at once
    stubFreeSpace(requiredBytes + requiredTempBytes - 1);
    const problems = await runInstallPreflight({
      dataDir: path.join(root, 'data'), tempDir: path.join(root, 'tmp'),
      requiredBytes, requiredTempBytes, longPathsEnabled: true,
    });
    const disk = problems.filter(p => p.kind === 'disk-space');
    expect(disk).toHaveLength(1);
    expect(disk[0].severity).toBe('blocking');
    expect(disk[0].message).toMatch(/both there/);
  });

  it('passes quietly with the sum plus margin free', async () => {
    stubFreeSpace(requiredBytes + requiredTempBytes + LOW_SPACE_MARGIN_BYTES + 1);
    const problems = await runInstallPreflight({
      dataDir: path.join(root, 'data'), tempDir: path.join(root, 'tmp'),
      requiredBytes, requiredTempBytes, longPathsEnabled: true,
    });
    expect(problems).toEqual([]);
  });

  it('warns when the install fits with little room to spare', async () => {
    stubFreeSpace(requiredBytes + 1);
    const problems = await runInstallPreflight({
      dataDir: path.join(root, 'data'), requiredBytes, longPathsEnabled: true,
    });
    expect(problems).toEqual([expect.objectContaining({ kind: 'disk-space', severity: 'warning' })]);
  });

  it('checks each volume on its own when they differ', async () => {
    const dataDir = path.join(root, 'data');
    const tempDir = path.join(root, 'tmp');
    await fs.promises.mkdir(dataDir);
    await fs.promises.mkdir(tempDir);
    // Tell the two folders apart as if they were separate drives
    const realStat = fs.promises.stat;
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (p: fs.PathLike, opts?: fs.StatOptions) => {
      const stat = await realStat(p, opts) as fs.Stats;
      return Object.assign(stat, { dev: String(p).startsWith(tempDir) ? 2 : 1 });
    }) as typeof fs.promises.stat);
    // Data volume has plenty; temp volume has less than the temp figure
    stubFreeSpace(dir => (dir.startsWith(tempDir) ? requiredTempBytes - 1 : 100 * GB));

    const problems = await runInstallPreflight({
      dataDir, tempDir, requiredBytes, requiredTempBytes, longPathsEnabled: true,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: 'disk-space', severity: 'blocking' });
    expect(problems[0].message).toMatch(/temp folder/);
  });

  it('stays quiet when free space is unknown', async () => {
    vi.spyOn(fs.promises, 'statfs').mockRejectedValue(new Error('nope'));
    const problems = await runInstallPreflight({
      dataDir: path.join(root, 'data'), requiredBytes: 1e15, longPathsEnabled: true,
    });
    expect(problems).toEqual([]);
  });
});

describe('runInstallPreflight writability', () => {
  beforeEach(() => { stubFreeSpace(1000 * GB); });

  it('blocks when the data folder refuses writes', async () => {
    const err = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    vi.spyOn(fs.promises, 'open').mockRejectedValue(err);
    const problems = await runInstallPreflight({
      dataDir: path.join(root, 'data'), requiredBytes: 1, longPathsEnabled: true,
    });
    expect(problems[0]).toMatchObject({ kind: 'not-writable', severity: 'blocking' });
    expect(problems[0].message).toMatch(/Program Files/);
  });

  it('probes the parent when the data folder does not exist yet, and cleans up', async () => {
    const open = vi.spyOn(fs.promises, 'open');
    const problems = await runInstallPreflight({
      dataDir: path.join(root, 'missing', 'data'), requiredBytes: 1, longPathsEnabled: true,
    });
    expect(problems).toEqual([]);
    expect(path.dirname(String(open.mock.calls[0][0]))).toBe(root);
    expect(await fs.promises.readdir(root)).toEqual([]);
  });

  it('does not call other write errors not-writable', async () => {
    const err = Object.assign(new Error('no space'), { code: 'ENOSPC' });
    vi.spyOn(fs.promises, 'open').mockRejectedValue(err);
    const problems = await runInstallPreflight({
      dataDir: root, requiredBytes: 1, longPathsEnabled: true,
    });
    expect(problems.filter(p => p.kind === 'not-writable')).toEqual([]);
  });
});

describe('isProtectedLocation', () => {
  const env = {
    ProgramFiles: 'E:\\Program Files',
    'ProgramFiles(x86)': 'E:\\Program Files (x86)',
    SystemRoot: 'E:\\WINDOWS',
  };

  it('matches the folders the env names, ignoring case', () => {
    expect(isProtectedLocation('e:\\program files\\Vapourkit\\data', env)).toBe(true);
    expect(isProtectedLocation('E:\\Program Files (x86)\\Vapourkit\\data', env)).toBe(true);
    expect(isProtectedLocation('E:\\Windows\\Temp\\vk', env)).toBe(true);
  });

  it('does not match lookalike siblings or user folders', () => {
    expect(isProtectedLocation('E:\\Program Files Extra\\Vapourkit\\data', env)).toBe(false);
    expect(isProtectedLocation('E:\\Games\\Vapourkit\\data', env)).toBe(false);
    expect(isProtectedLocation('C:\\Program Files\\Vapourkit\\data', env)).toBe(false);
  });

  it('falls back to the usual C: folders without the env vars', () => {
    expect(isProtectedLocation('C:\\Program Files\\Vapourkit\\data', {})).toBe(true);
    expect(isProtectedLocation('C:\\Program Files (x86)\\Vapourkit\\data', {})).toBe(true);
    expect(isProtectedLocation('C:\\Windows\\vk', {})).toBe(true);
    expect(isProtectedLocation('C:\\Users\\me\\Vapourkit\\data', {})).toBe(false);
  });

  it.runIf(onWindows)('is reported as a warning by the preflight', async () => {
    stubFreeSpace(1000 * GB);
    vi.stubEnv('ProgramFiles', root);
    const problems = await runInstallPreflight({
      dataDir: path.join(root, 'Vapourkit', 'data'), requiredBytes: 1, longPathsEnabled: true,
    });
    expect(problems).toEqual([expect.objectContaining({ kind: 'protected-location', severity: 'warning' })]);
  });
});

describe.runIf(onWindows)('runInstallPreflight path length', () => {
  beforeEach(() => {
    stubFreeSpace(1000 * GB);
    // These paths do not exist; keep the write probe off the real C:\
    vi.spyOn(fs.promises, 'open').mockResolvedValue({ close: async () => {} } as unknown as fs.promises.FileHandle);
    vi.spyOn(fs.promises, 'unlink').mockResolvedValue();
  });

  const dataDirOfLength = (length: number) => `C:\\${'d'.repeat(length - 3)}`;
  const pathLength = (problems: Awaited<ReturnType<typeof runInstallPreflight>>) =>
    problems.filter(p => p.kind === 'path-length');

  it('allows a data folder right at the limit', async () => {
    const problems = await runInstallPreflight({
      dataDir: dataDirOfLength(MAX_DATA_DIR_LENGTH), requiredBytes: 1, longPathsEnabled: false,
    });
    expect(pathLength(problems)).toEqual([]);
  });

  it('warns one character past it', async () => {
    const problems = await runInstallPreflight({
      dataDir: dataDirOfLength(MAX_DATA_DIR_LENGTH + 1), requiredBytes: 1, longPathsEnabled: false,
    });
    expect(pathLength(problems)).toEqual([expect.objectContaining({ severity: 'warning' })]);
  });

  it('says nothing when Windows long paths are on', async () => {
    const problems = await runInstallPreflight({
      dataDir: dataDirOfLength(MAX_DATA_DIR_LENGTH + 40), requiredBytes: 1, longPathsEnabled: true,
    });
    expect(pathLength(problems)).toEqual([]);
  });

  it('checks the temp folder pip installs through', async () => {
    const ok = await runInstallPreflight({
      dataDir: 'C:\\vk', tempDir: dataDirOfLength(MAX_TEMP_DIR_LENGTH), requiredBytes: 1, longPathsEnabled: false,
    });
    expect(pathLength(ok)).toEqual([]);
    const tooLong = await runInstallPreflight({
      dataDir: 'C:\\vk', tempDir: dataDirOfLength(MAX_TEMP_DIR_LENGTH + 1), requiredBytes: 1, longPathsEnabled: false,
    });
    expect(pathLength(tooLong)).toHaveLength(1);
    expect(pathLength(tooLong)[0].message).toMatch(/temp folder/);
  });
});

describe('prunePipCache', () => {
  async function fillCache(dir: string): Promise<number> {
    await fs.promises.mkdir(path.join(dir, 'http-v2', 'a', 'b'), { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'http-v2', 'a', 'b', 'body'), Buffer.alloc(2000));
    await fs.promises.writeFile(path.join(dir, 'http-v2', 'a', 'meta'), Buffer.alloc(700));
    await fs.promises.writeFile(path.join(dir, 'selfcheck.json'), Buffer.alloc(300));
    return 3000;
  }

  it('leaves a cache under the limit alone', async () => {
    const cache = path.join(root, 'pip-cache');
    await fillCache(cache);
    expect(await prunePipCache(cache, 3000)).toBe(0);
    expect(fs.existsSync(path.join(cache, 'http-v2', 'a', 'b', 'body'))).toBe(true);
  });

  it('removes a cache over the limit and reports what it freed', async () => {
    const cache = path.join(root, 'pip-cache');
    const size = await fillCache(cache);
    expect(await prunePipCache(cache, 1000)).toBe(size);
    expect(fs.existsSync(cache)).toBe(false);
  });

  it('answers 0 for a cache that does not exist', async () => {
    expect(await prunePipCache(path.join(root, 'nothing'), 0)).toBe(0);
  });

  it('never throws when removal fails', async () => {
    const cache = path.join(root, 'pip-cache');
    await fillCache(cache);
    vi.spyOn(fs.promises, 'rm').mockRejectedValue(Object.assign(new Error('busy'), { code: 'EBUSY' }));
    expect(await prunePipCache(cache, 1000)).toBe(0);
    expect(fs.existsSync(cache)).toBe(true);
  });
});

describe('required sizes', () => {
  it('asks more of an NVIDIA install than of the others, and more of either than core setup', () => {
    for (const vendor of ['amd', 'intel', 'unknown'] as const) {
      expect(PLUGIN_INSTALL_REQUIRED_BYTES.nvidia).toBeGreaterThan(PLUGIN_INSTALL_REQUIRED_BYTES[vendor]);
      expect(PLUGIN_INSTALL_REQUIRED_BYTES[vendor]).toBeGreaterThan(CORE_SETUP_REQUIRED_BYTES);
    }
  });

  it('leaves room for the measured deepest path', () => {
    expect(MAX_DATA_DIR_LENGTH).toBe(46);
    expect(MAX_TEMP_DIR_LENGTH).toBe(54);
  });
});
