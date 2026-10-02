// electron/alignHandlers.ts — lines a side chain's video up with the main one.
//
// Runs data/config/align_videos.py (include/) in the app's Python, which
// answers in JSON lines: progress while it works, then one result or error.
// The result becomes the Load Video step's `align` (chainGraph.ts), which the
// generator uses to put the side chain on the main source's timeline.
//
// One run per Load Video at a time; starting another for the same step, or
// cancelling, ends the one before. A run is reading two whole videos' worth
// of index on its first go, so it has to be stoppable.

import { ipcMain, type WebContents } from 'electron';
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs-extra';
import { PATHS } from './constants';
import { logger } from './logger';
import { setupVSEnvironment } from './utils';
import { createWorkloadSpawnOptions, terminateProcessTree } from './processLifecycle';
import type { SideChainAlignment } from './chainGraph';

/** What align_videos.py measured, before the app adds which video it was against. */
export type MeasuredAlignment = Omit<SideChainAlignment, 'alignedTo'> & {
  mainFps?: number;
  refFps?: number;
  residualFrames?: number | null;
};

export type AlignOutcome =
  | { success: true; alignment: SideChainAlignment }
  | { success: false; error: string; cancelled?: boolean };

export interface AlignProgress {
  id: string;
  progress: number;
  message: string;
}

/**
 * Reads align_videos.py's stdout, one JSON object per line, into progress
 * reports and the final answer. Lines that are not JSON are VapourSynth or
 * plugin chatter and are passed to the log instead.
 */
export class AlignOutputReader {
  private buffer = '';
  result: MeasuredAlignment | null = null;
  error: string | null = null;

  constructor(
    private readonly onProgress: (progress: number, message: string) => void,
    private readonly onOther: (line: string) => void = () => {},
  ) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let at: number;
    while ((at = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (line) this.line(line);
    }
  }

  private line(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.onOther(line);
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const message = parsed as Record<string, unknown>;
    if (typeof message.error === 'string') this.error = message.error;
    else if (message.result && typeof message.result === 'object') this.result = message.result as MeasuredAlignment;
    else if (typeof message.progress === 'number') {
      this.onProgress(Math.min(1, Math.max(0, message.progress)), String(message.message ?? ''));
    }
  }
}

const running = new Map<string, ChildProcess>();

function stop(id: string): boolean {
  const child = running.get(id);
  if (!child) return false;
  running.delete(id);
  terminateProcessTree(child);
  return true;
}

export function runAlignment(
  id: string,
  mainPath: string,
  refPath: string,
  sender: WebContents | null,
): Promise<AlignOutcome> {
  return new Promise(resolve => {
    const scriptPath = path.join(PATHS.CONFIG, 'align_videos.py');
    if (!fs.existsSync(scriptPath)) {
      resolve({ success: false, error: `The aligner is missing from ${PATHS.CONFIG}. Restart Vapourkit to restore it.` });
      return;
    }
    stop(id);

    const report = (progress: number, message: string) => {
      if (sender && !sender.isDestroyed()) sender.send('align-progress', { id, progress, message } satisfies AlignProgress);
    };
    const reader = new AlignOutputReader(report, line => logger.debug(`[align] ${line}`));
    const child = spawn(
      PATHS.PYTHON,
      ['-u', scriptPath, mainPath, refPath],
      createWorkloadSpawnOptions({
        cwd: PATHS.VS,
        env: setupVSEnvironment(PATHS.PYTHON),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }),
    );
    running.set(id, child);
    logger.info(`Aligning ${refPath} to ${mainPath}`);

    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => reader.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    child.on('error', error => {
      running.delete(id);
      resolve({ success: false, error: `The aligner could not start: ${error.message}` });
    });
    child.on('close', code => {
      const stoppedHere = running.get(id) !== child;
      if (!stoppedHere) running.delete(id);
      reader.push('\n');
      if (stoppedHere && !reader.result) {
        resolve({ success: false, error: 'Alignment was stopped.', cancelled: true });
        return;
      }
      if (reader.result) {
        const { mainFps: _m, refFps: _r, residualFrames, ...measured } = reader.result;
        void _m; void _r;
        logger.info(`Aligned: speed ${measured.speed}, ${measured.sections.length} section(s), ` +
          `${measured.matched}/${measured.usable}/${measured.samples} matched/usable/tried, worst ${residualFrames} frames`);
        resolve({ success: true, alignment: { ...measured, alignedTo: mainPath } });
        return;
      }
      const error = reader.error
        ?? (stderr.trim().split(/\r?\n/).filter(Boolean).pop() || `The aligner exited with code ${code}.`);
      logger.warn(`Alignment failed: ${error}`);
      resolve({ success: false, error });
    });
  });
}

export function registerAlignHandlers(): void {
  ipcMain.handle('align-side-chain', (event, params: { id: string; mainPath: string; refPath: string }) =>
    runAlignment(params.id, params.mainPath, params.refPath, event.sender));
  ipcMain.handle('cancel-align', (_event, id: string) => ({ success: stop(id) }));
}
