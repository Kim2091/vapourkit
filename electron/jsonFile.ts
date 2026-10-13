// electron/jsonFile.ts — JSON state files that survive crashes and racing saves.
//
// app-config.json and queue.json used to be written with a plain writeFile
// from every setter. Two saves in flight at once (selecting a queue item sets
// five settings in a row) each truncate the file and write their own copy, and
// when the later one is shorter the tail of the earlier one is left behind:
// invalid JSON. A crash mid-write leaves half a file. Either way the next
// launch could not read it and started from defaults, which the first save
// then wrote over everything the user had.
//
// So a file is written beside and renamed into place, the newest snapshot
// always wins however the writes finish, and a file that cannot be read is
// moved aside before anything is allowed to replace it.

import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs-extra';

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

const tempPathFor = (file: string) =>
  `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Written beside and renamed into place, so a crash mid-write cannot leave
 * half a file. A plain rename replaces the old file in one step; fs-extra's
 * move with overwrite deletes it first, and a read landing in that gap finds
 * nothing.
 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.ensureDir(path.dirname(file));
  // Unique per write, so two writers can never rename each other's file.
  const temp = tempPathFor(file);
  await fs.writeJson(temp, value, { spaces: 2 });
  // Windows refuses to replace a file another handle has open; a reader
  // holds it for a moment only.
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(temp, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || !code || !RETRYABLE.has(code)) {
        await fs.remove(temp).catch(() => undefined);
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 50 * attempt));
    }
  }
}

/** renameSync with the same short retry, for the paths that may not await. */
function renameSyncWithRetry(temp: string, file: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(temp, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || !code || !RETRYABLE.has(code)) {
        try { fs.removeSync(temp); } catch { /* already gone */ }
        throw error;
      }
      sleepSync(50 * attempt);
    }
  }
}

/**
 * One JSON file with any number of writers, where the last snapshot taken is
 * the one that stays.
 *
 * Each write serializes its value when it is called and writes it to its own
 * temporary file, so writes in flight never share bytes. The rename into
 * place is synchronous and only happens if no newer write has landed first:
 * an older save that finishes late is thrown away instead of putting older
 * state back. That also holds against writeSync, which the window uses as it
 * closes and which cannot wait for anything in flight.
 */
export class JsonFileWriter {
  private issued = 0;
  private landed = 0;
  private blockedReason: string | null = null;

  constructor(private readonly file: () => string) {}

  /**
   * Refuse to write until unblock(): the file could not be read or moved
   * aside, so it may hold the user's state, and a write would replace it.
   */
  block(reason: string): void {
    this.blockedReason = reason;
  }

  unblock(): void {
    this.blockedReason = null;
  }

  get blocked(): string | null {
    return this.blockedReason;
  }

  async write(value: unknown): Promise<void> {
    if (this.blockedReason) throw new Error(`Not saved: ${this.blockedReason}`);
    const mine = ++this.issued;
    const file = this.file();
    const text = JSON.stringify(value, null, 2);
    await fs.ensureDir(path.dirname(file));
    const temp = tempPathFor(file);
    await fs.writeFile(temp, text, 'utf-8');
    for (let attempt = 1; ; attempt++) {
      // Checked right before the rename, with no await between, so a newer
      // write cannot land in the gap.
      if (mine < this.landed) {
        await fs.remove(temp).catch(() => undefined);
        return;
      }
      try {
        fs.renameSync(temp, file);
        this.landed = mine;
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 5 || !code || !RETRYABLE.has(code)) {
          await fs.remove(temp).catch(() => undefined);
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 50 * attempt));
      }
    }
  }

  writeSync(value: unknown): void {
    if (this.blockedReason) throw new Error(`Not saved: ${this.blockedReason}`);
    const mine = ++this.issued;
    const file = this.file();
    fs.ensureDirSync(path.dirname(file));
    const temp = tempPathFor(file);
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf-8');
    renameSyncWithRetry(temp, file);
    this.landed = mine;
  }
}

export type JsonReadResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'missing' }
  /** Not JSON. Moved to setAsideTo, or null if even that failed. */
  | { kind: 'corrupt'; error: unknown; setAsideTo: string | null }
  /** Could not be read at all (locked, permissions): left where it is. */
  | { kind: 'unreadable'; error: unknown };

/**
 * Read a JSON file, moving it aside if it is not JSON.
 *
 * The copy keeps whatever can still be recovered by hand, and moving it out
 * of the way is what makes it safe for the caller to start over and save.
 */
export async function readJsonOrSetAside<T>(file: string): Promise<JsonReadResult<T>> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'unreadable', error };
  }
  try {
    return { kind: 'ok', value: JSON.parse(text) as T };
  } catch (error) {
    const ext = path.extname(file);
    const setAside = `${file.slice(0, file.length - ext.length)}.unreadable-${Date.now()}${ext}`;
    try {
      await fs.rename(file, setAside);
      return { kind: 'corrupt', error, setAsideTo: setAside };
    } catch {
      try {
        await fs.copy(file, setAside);
        return { kind: 'corrupt', error, setAsideTo: setAside };
      } catch {
        return { kind: 'corrupt', error, setAsideTo: null };
      }
    }
  }
}
