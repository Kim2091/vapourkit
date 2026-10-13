import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonFileWriter, readJsonOrSetAside } from './jsonFile';

const dir = path.join(os.tmpdir(), `vk-jsonfile-test-${process.pid}`);
const file = path.join(dir, 'state.json');

describe('JsonFileWriter', () => {
  beforeEach(async () => { await fs.remove(dir); await fs.ensureDir(dir); });
  afterEach(async () => { await fs.remove(dir); });

  it('leaves valid JSON holding the newest snapshot when many saves overlap', async () => {
    const writer = new JsonFileWriter(() => file);
    // Alternating lengths: with plain writeFile a shorter late write left the
    // tail of a longer one behind.
    for (let round = 0; round < 20; round++) {
      const writes = Array.from({ length: 6 }, (_, i) =>
        writer.write({ round, i, pad: i % 2 ? 'x' : 'y'.repeat(4000) }));
      await Promise.all(writes);
      expect(await fs.readJson(file)).toEqual({ round, i: 5, pad: 'x' });
    }
    expect((await fs.readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('never lets an older save land over a synchronous one made after it', async () => {
    const writer = new JsonFileWriter(() => file);
    const older = writer.write({ which: 'older', pad: 'z'.repeat(100000) });
    writer.writeSync({ which: 'on close' });
    await older;
    expect(await fs.readJson(file)).toEqual({ which: 'on close' });
  });

  it('refuses to write while blocked', async () => {
    await fs.writeFile(file, 'keep me');
    const writer = new JsonFileWriter(() => file);
    writer.block('unreadable');
    await expect(writer.write([])).rejects.toThrow('unreadable');
    expect(() => writer.writeSync([])).toThrow('unreadable');
    expect(await fs.readFile(file, 'utf8')).toBe('keep me');
  });
});

describe('readJsonOrSetAside', () => {
  beforeEach(async () => { await fs.remove(dir); await fs.ensureDir(dir); });
  afterEach(async () => { await fs.remove(dir); });

  it('reads JSON and reports a missing file', async () => {
    expect(await readJsonOrSetAside(file)).toEqual({ kind: 'missing' });
    await fs.writeJson(file, [1, 2]);
    expect(await readJsonOrSetAside(file)).toEqual({ kind: 'ok', value: [1, 2] });
  });

  it('moves a file that is not JSON aside, keeping its bytes', async () => {
    await fs.writeFile(file, '{"models": {}}}');
    const read = await readJsonOrSetAside(file);
    expect(read.kind).toBe('corrupt');
    const setAside = read.kind === 'corrupt' ? read.setAsideTo : null;
    expect(setAside).toMatch(/state\.unreadable-\d+\.json$/);
    expect(await fs.pathExists(file)).toBe(false);
    expect(await fs.readFile(setAside!, 'utf8')).toBe('{"models": {}}}');
  });
});
