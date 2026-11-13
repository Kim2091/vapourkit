import * as fs from 'fs-extra';
import * as path from 'path';
import { spawn } from 'child_process';
import { app } from 'electron';
import { PATHS } from './constants';
import { fixAsarPath } from './utils';
import { logger } from './logger';

export const sourceIndexRoot = () => path.join(PATHS.APP_DATA, 'cache', 'bestsource');
let staged: Promise<string> | null = null;
export function ensureSourceIndexHelper(): Promise<string> {
  return staged ??= (async () => {
    const target = path.join(PATHS.APP_DATA, 'vk_source_cache.py');
    const content = await fs.readFile(path.join(fixAsarPath(app.getAppPath()), 'include', 'vk_source_cache.py'));
    const existing = await fs.readFile(target).catch(() => null);
    if (!existing?.equals(content)) {
      await fs.ensureDir(PATHS.APP_DATA);
      const temporary = `${target}.${process.pid}.tmp`;
      await fs.writeFile(temporary, content); await fs.move(temporary, target, { overwrite: true });
    }
    return target;
  })().catch(error => { staged = null; throw error; });
}

let queued: string[] = [];
const completed = new Map<string, number>();
let completionVersion = 0;
let running = false;
let serial: Promise<unknown> = Promise.resolve();
let retry: ReturnType<typeof setInterval> | undefined;
let lastSweepAt = 0;
export function holdQueuedSourceIndexes(queue: Array<{status?: string; videoPath?: string}>): void {
  queued = queue.filter(item => item && (item.status === 'pending' || item.status === 'processing')).flatMap(item => {
    const filters = (item as any).workflow?.filters;
    return [item.videoPath, ...(Array.isArray(filters) ? filters.filter((f: any) => f?.enabled && f.filterType === 'videoSource').map((f: any) => f.sourcePath) : [])];
  }).filter((file): file is string => typeof file === 'string');
  void sweepSourceIndexes();
}
export function completedSourceIndexes(sources: string[]): void {
  for (const source of sources) completed.set(source, ++completionVersion);
  void sweepSourceIndexes();
}
/** A new attempt supersedes an older completion marker, including on failure. */
export async function beginSourceIndexes(sources: string[]): Promise<void> {
  for (const source of sources) completed.delete(source);
  try { await requestCleanup({ retain: sources }); }
  catch (error) { logger.warn('Could not reset source index completion marker:', error); }
}
function requestCleanup(request: {complete?: string[]; retain?: string[]}): Promise<{cleaned: number; deferred: number}> {
  const operation = serial.then(async () => {
    const helper = await ensureSourceIndexHelper();
    return new Promise<{cleaned: number; deferred: number}>((resolve, reject) => {
      const child = spawn(PATHS.PYTHON, ['-I', '-X', 'utf8', helper, sourceIndexRoot()], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
      let output = '', errors = '';
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Source cache cleanup timed out')); }, 15000);
      child.stdout.on('data', data => { output = (output + data).slice(-4096); });
      child.stderr.on('data', data => { errors = (errors + data).slice(-4096); });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('close', code => { clearTimeout(timeout); try { if (code !== 0) throw new Error(errors || `Cleanup exit ${code}`); resolve(JSON.parse(output)); } catch (error) { reject(error); } });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ ...request, keep: queued }));
    });
  });
  serial = operation.catch(() => {});
  return operation;
}
async function sweepSourceIndexes(): Promise<void> {
  if (running) return;
  running = true;
  const batch = [...completed.entries()];
  try {
    if (!batch.length && !await fs.pathExists(sourceIndexRoot())) return;
    if (!batch.length) {
      if (Date.now() - lastSweepAt < 5000) return;
      const directories = await fs.readdir(sourceIndexRoot(), { withFileTypes: true });
      const pending = await Promise.all(directories.filter(entry => entry.isDirectory()).map(entry => fs.pathExists(path.join(sourceIndexRoot(), entry.name, 'cleanup.pending'))));
      if (!pending.some(Boolean)) {
        if (retry) { clearInterval(retry); retry = undefined; }
        return;
      }
    }
    lastSweepAt = Date.now();
    const result = await requestCleanup({ complete: batch.map(([source]) => source) });
    for (const [source, version] of batch) if (completed.get(source) === version) completed.delete(source);
    if (result.cleaned) logger.info(`[source-cache] Removed indexes for ${result.cleaned} completed source(s)`);
    if (result.deferred || completed.size) {
      retry ??= setInterval(() => { void sweepSourceIndexes(); }, 10000);
      retry.unref();
    } else if (retry) { clearInterval(retry); retry = undefined; }
  } catch (error) { logger.warn('Source index cleanup deferred:', error); retry ??= setInterval(() => { void sweepSourceIndexes(); }, 10000); retry.unref(); }
  finally { running = false; }
}
