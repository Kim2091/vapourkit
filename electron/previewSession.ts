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
//
// Playback frames are the exception: they are pushed, not requested, so they
// carry a stream id instead of a seq and are routed to `onStream` rather than
// to a waiter. Everything the server writes still goes down one pipe in
// order, which is what lets a stop be trusted — after its reply, no further
// frame of that stream can be in flight.

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

/** Floor, ceiling and 0.1/99.9 percentiles, in 8-bit code values. */
export interface PreviewSpread {
  min: number;
  max: number;
  low: number;
  high: number;
}

export interface PreviewLevels {
  r: PreviewSpread;
  g: PreviewSpread;
  b: PreviewSpread;
  /** Rec.709 luma — the trace a colourist reads a black level off. */
  y: PreviewSpread;
}

/** How the clip feeding this step is tagged, before the RGB conversion. */
export interface PreviewSourceProps {
  /** VapourSynth's convention: 0 full, 1 limited, null when the file is silent. */
  colorRange: number | null;
  matrix: number | null;
  transfer: number | null;
  primaries: number | null;
  format: string | null;
}

/** A pushed playback frame, or the end of a stream. */
export type StreamEvent =
  | {
      type: 'pframe';
      stream: number;
      n: number;
      output: number;
      width: number;
      height: number;
      data: Buffer;
    }
  | { type: 'end'; stream: number; n: number | null }
  | { type: 'error'; stream: number; n: number; error: string };

export interface PlayOptions {
  /** Caller-assigned id, echoed on every frame so stale ones can be dropped. */
  stream: number;
  output: number;
  /** First frame, in the output's own numbering. */
  from: number;
  width: number;
  /** Frames the server may send before it must wait for more credit. */
  credits: number;
  prefetch?: number;
}

export interface PreviewFrame {
  n: number;
  width: number;
  height: number;
  output: number;
  data: Buffer;
  levels: PreviewLevels | null;
  source: PreviewSourceProps | null;
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

  /**
   * Where pushed playback frames go. Set by whoever owns the port they are
   * forwarded to; unset means playback frames are dropped, which is the right
   * behaviour for a session nobody is playing.
   */
  onStream?: (event: StreamEvent) => void;

  /** Injected so the protocol can be tested against a fake child. */
  constructor(private readonly spawner: typeof spawn = spawn) {}

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
    const child = this.spawner(
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
      // A dead session has no stream. Clearing the sink stops a late chunk
      // already in the reader from being forwarded to a port being closed.
      this.onStream = undefined;
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
      levels: header.levels ?? null,
      source: header.source ?? null,
    };
  }

  // -- playback ----------------------------------------------------------

  /**
   * Starts pushing frames from `output`, beginning at `from`.
   *
   * Replaces whatever stream was running. Frames arrive on `onStream` and
   * stop after `credits` of them until `credit` grants more.
   */
  async play(options: PlayOptions): Promise<{ stream: number; prefetch: number; from: number }> {
    const { header } = await this.send({ cmd: 'play', ...options });
    return {
      stream: header.stream,
      prefetch: header.prefetch,
      from: header.from,
    };
  }

  /** Stops `stream` and reports the last frame it emitted. */
  async stop(stream: number): Promise<number | null> {
    const { header } = await this.send({ cmd: 'stop', stream });
    return header.n ?? null;
  }

  /**
   * Grants room for `count` more frames.
   *
   * Deliberately not a request: a reply per frame consumed would put the
   * round trip back on the path that the push model exists to remove.
   */
  credit(stream: number, count: number): void {
    this.post({ cmd: 'credit', stream, count });
  }

  dispose(): void {
    const child = this.child;
    this.child = null;
    this.reader = null;
    this.outputs = [];
    this.onStream = undefined;
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

  /** Write a command that expects no reply. */
  private post(command: Record<string, unknown>): void {
    const child = this.child;
    if (!child?.stdin) return;
    try {
      child.stdin.write(JSON.stringify(command) + '\n');
    } catch {
      // Broken pipe: the session is going away and the credit is moot.
    }
  }

  private onReply(reply: Reply): void {
    if (this.routeStreamEvent(reply)) return;

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

  /**
   * Pushed frames have a stream id and no seq, so they belong to the sink
   * rather than to the pending map. Returns true when it handled the reply.
   */
  private routeStreamEvent(reply: Reply): boolean {
    const { header, payload } = reply;
    const type = header.type;
    const stream = header.stream;
    if (typeof stream !== 'number') return false;
    if (type !== 'pframe' && type !== 'end' && type !== 'error') return false;
    // play and stop both echo the stream on an `ok` that a caller is waiting
    // for; only these three are pushed.
    if (header.seq !== undefined) return false;

    const sink = this.onStream;
    if (!sink) {
      logger.debug(`[preview] no stream sink; dropped ${type} for stream ${stream}`);
      return true;
    }

    if (type === 'pframe') {
      if (!payload) {
        logger.debug('[preview] pframe carried no pixels');
        return true;
      }
      sink({
        type: 'pframe',
        stream,
        n: header.n,
        output: header.output,
        width: header.width,
        height: header.height,
        data: payload,
      });
    } else if (type === 'end') {
      sink({ type: 'end', stream, n: header.n ?? null });
    } else {
      sink({
        type: 'error',
        stream,
        n: header.n ?? -1,
        error: String(header.error ?? 'Unknown playback error'),
      });
    }
    return true;
  }

  private failAllPending(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}
