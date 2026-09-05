// electron/previewSession.ts — the Node half of the warm preview session.
//
// Owns one long-lived python child running data/config/preview_server.py, and
// speaks its framed protocol: line-delimited JSON out, length-prefixed
// {header}{packed RGB24} back. One session exists while the preview panel is
// open; it is torn down on close and on app shutdown.
//
// Replies carry the sequence number of the request that caused them, so a
// reply that arrives after the caller has moved on is discarded rather than
// mistaken for the answer to a later question.

import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs-extra';
import { PATHS } from './constants';
import { logger } from './logger';
import { setupVSEnvironment } from './utils';
import { createWorkloadSpawnOptions, terminateProcessTree } from './processLifecycle';

export interface PreviewOutput {
  index: number;
  width: number;
  height: number;
  frames: number;
  fpsNum: number;
  fpsDen: number;
  format: string | null;
}

export interface PreviewFrame {
  n: number;
  width: number;
  height: number;
  output: number;
  data: Buffer;
}

interface Reply {
  header: Record<string, any>;
  payload: Buffer | null;
}

type ReadState = 'length' | 'header' | 'payload';

/**
 * Incremental reader for {uint32 length}{header}{payload}.
 *
 * Every byte is copied exactly once, into a buffer allocated when its size
 * becomes known. The obvious Buffer.concat version measured 17 ms per 1280px
 * frame against 2.9 ms for this one, which is most of a frame budget spent on
 * nothing.
 */
export class FrameReader {
  private state: ReadState = 'length';
  private readonly lengthBuf = Buffer.alloc(4);
  private lengthFilled = 0;
  private headerBuf: Buffer | null = null;
  private headerFilled = 0;
  private payloadBuf: Buffer | null = null;
  private payloadFilled = 0;
  private header: Record<string, any> | null = null;

  constructor(private readonly onReply: (reply: Reply) => void) {}

  push(chunk: Buffer): void {
    let offset = 0;

    while (offset < chunk.length) {
      if (this.state === 'length') {
        const take = Math.min(4 - this.lengthFilled, chunk.length - offset);
        chunk.copy(this.lengthBuf, this.lengthFilled, offset, offset + take);
        this.lengthFilled += take;
        offset += take;

        if (this.lengthFilled === 4) {
          this.headerBuf = Buffer.allocUnsafe(this.lengthBuf.readUInt32BE(0));
          this.headerFilled = 0;
          this.state = 'header';
        }
        continue;
      }

      if (this.state === 'header') {
        const target = this.headerBuf!;
        const take = Math.min(target.length - this.headerFilled, chunk.length - offset);
        chunk.copy(target, this.headerFilled, offset, offset + take);
        this.headerFilled += take;
        offset += take;

        if (this.headerFilled === target.length) {
          this.header = JSON.parse(target.toString('utf8'));
          const bytes: number = this.header?.bytes ?? 0;
          if (bytes > 0) {
            this.payloadBuf = Buffer.allocUnsafe(bytes);
            this.payloadFilled = 0;
            this.state = 'payload';
          } else {
            this.deliver(null);
          }
        }
        continue;
      }

      const target = this.payloadBuf!;
      const take = Math.min(target.length - this.payloadFilled, chunk.length - offset);
      chunk.copy(target, this.payloadFilled, offset, offset + take);
      this.payloadFilled += take;
      offset += take;

      if (this.payloadFilled === target.length) {
        this.deliver(target);
      }
    }
  }

  private deliver(payload: Buffer | null): void {
    const header = this.header!;
    this.state = 'length';
    this.lengthFilled = 0;
    this.headerBuf = null;
    this.payloadBuf = null;
    this.header = null;
    this.onReply({ header, payload });
  }
}

export class PreviewSession {
  private child: ChildProcess | null = null;
  private reader: FrameReader | null = null;
  private seq = 0;
  private readonly pending = new Map<
    number,
    { resolve: (reply: Reply) => void; reject: (error: Error) => void }
  >();
  private exitReason: string | null = null;

  /** The steps the open script exposes, in output order. */
  outputs: PreviewOutput[] = [];

  get isRunning(): boolean {
    return this.child !== null;
  }

  /**
   * Starts the python child. The server is cheap until `open` is called, so a
   * session can be started ahead of a script being ready.
   */
  async start(): Promise<void> {
    if (this.child) return;

    const serverPath = path.join(PATHS.CONFIG, 'preview_server.py');
    if (!(await fs.pathExists(serverPath))) {
      throw new Error(`Preview server not found at ${serverPath}`);
    }
    if (!(await fs.pathExists(PATHS.PYTHON))) {
      throw new Error('Python not found; VapourSynth dependencies may not be installed.');
    }

    this.exitReason = null;
    this.reader = new FrameReader(reply => this.onReply(reply));

    // -u so stderr reaches the log promptly; stdout is flushed explicitly by
    // the server after every reply.
    const child = spawn(
      PATHS.PYTHON,
      ['-u', serverPath],
      createWorkloadSpawnOptions({
        cwd: PATHS.VS,
        env: setupVSEnvironment(PATHS.PYTHON),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }),
    );

    child.stdout?.on('data', (chunk: Buffer) => this.reader?.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trimEnd();
      if (text) logger.debug(`[preview] ${text}`);
    });
    child.on('exit', (code, signal) => {
      this.exitReason = signal ? `signal ${signal}` : `code ${code}`;
      this.failAllPending(new Error(`Preview session exited (${this.exitReason})`));
      this.child = null;
      this.reader = null;
    });
    child.on('error', error => {
      this.failAllPending(new Error(`Preview session failed to start: ${error.message}`));
      this.child = null;
      this.reader = null;
    });

    this.child = child;
  }

  /**
   * Executes a generated script and reports its steps.
   *
   * The script must have been generated with generatePreviewOutputs, which
   * registers the source as output 0 and one output per enabled filter. Names
   * are not read back from it — the app built the chain and labels the steps
   * from its own filter list.
   */
  async open(scriptPath: string, maxCacheMb = 1000): Promise<PreviewOutput[]> {
    const reply = await this.send({ cmd: 'open', script: scriptPath, maxCacheMb });
    this.outputs = (reply.header.outputs ?? []) as PreviewOutput[];
    return this.outputs;
  }

  async select(index: number): Promise<void> {
    await this.send({ cmd: 'select', index });
  }

  /** Renders one frame from the selected step, scaled to `width` if narrower. */
  async frame(n: number, width = 0): Promise<PreviewFrame> {
    const { header, payload } = await this.send({ cmd: 'frame', n, width });
    if (!payload) throw new Error('Preview frame reply carried no pixels');
    return {
      n: header.n,
      width: header.width,
      height: header.height,
      output: header.output,
      data: payload,
    };
  }

  dispose(): void {
    const child = this.child;
    this.child = null;
    this.reader = null;
    this.outputs = [];
    this.failAllPending(new Error('Preview session closed'));

    if (!child) return;
    try {
      child.stdin?.write(JSON.stringify({ cmd: 'close', seq: -1 }) + '\n');
      child.stdin?.end();
    } catch {
      // Broken pipe means it is already gone.
    }
    // get_frame is blocking, so a session stuck in a slow render will not read
    // that close. Take the tree down rather than wait on it.
    terminateProcessTree(child);
  }

  // -- transport ---------------------------------------------------------

  private send(command: Record<string, unknown>): Promise<Reply> {
    const child = this.child;
    if (!child?.stdin) {
      return Promise.reject(
        new Error(
          this.exitReason
            ? `Preview session is not running (exited ${this.exitReason})`
            : 'Preview session is not running',
        ),
      );
    }

    const seq = ++this.seq;
    return new Promise<Reply>((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
      child.stdin!.write(JSON.stringify({ ...command, seq }) + '\n', error => {
        if (!error) return;
        this.pending.delete(seq);
        reject(new Error(`Preview session write failed: ${error.message}`));
      });
    });
  }

  private onReply(reply: Reply): void {
    const seq: number = reply.header.seq ?? -1;
    const waiter = this.pending.get(seq);
    if (!waiter) {
      // A reply to a request whose caller has moved on. Dropping it here is
      // what keeps a late frame from being painted over a newer one.
      logger.debug(`[preview] discarded stale reply seq=${seq}`);
      return;
    }
    this.pending.delete(seq);

    if (reply.header.type === 'error') {
      waiter.reject(new Error(String(reply.header.error ?? 'Unknown preview error')));
      return;
    }
    waiter.resolve(reply);
  }

  private failAllPending(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}
