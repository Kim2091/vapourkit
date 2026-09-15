// Streaming half of the preview protocol: pushed frames, credits, and the
// routing that keeps them out of the request/reply map.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';

// vi.mock is hoisted above every const, so the factory computes the path
// itself rather than closing over one.
vi.mock('electron', async () => {
  const p = await import('path');
  const o = await import('os');
  const root = p.join(o.tmpdir(), `vk-preview-stream-${process.pid}`);
  return { app: { isPackaged: false, getAppPath: () => root, getPath: () => root } };
});

const ROOT = path.join(os.tmpdir(), `vk-preview-stream-${process.pid}`);

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { PreviewSession, type StreamEvent } from './previewSession';
import { PATHS } from './constants';

/** A child process that speaks the wire protocol on command. */
function fakeChild() {
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const written: string[] = [];
  child.stdin = {
    write(chunk: string, cb?: (error?: Error | null) => void) {
      written.push(chunk);
      cb?.(null);
      return true;
    },
    end() {},
  };
  child.pid = 4242;
  child.kill = vi.fn();
  child.written = written;
  /** Everything the session has sent, parsed. */
  child.commands = () => written.map(line => JSON.parse(line.trim()));
  return child;
}

function encode(header: Record<string, unknown>, payload = Buffer.alloc(0)): Buffer {
  const body = Buffer.from(JSON.stringify({ ...header, bytes: payload.length }), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  return Buffer.concat([length, body, payload]);
}

async function startedSession() {
  const child = fakeChild();
  const session = new PreviewSession(() => child);
  await session.start();
  return { session, child };
}

/** Let the stdout PassThrough deliver before asserting. */
const settle = () => new Promise(resolve => setImmediate(resolve));

beforeEach(async () => {
  // start() checks the server script and interpreter exist before spawning.
  await fs.ensureDir(PATHS.CONFIG);
  await fs.writeFile(path.join(PATHS.CONFIG, 'preview_server.py'), '# stub');
  await fs.ensureDir(path.dirname(PATHS.PYTHON));
  await fs.writeFile(PATHS.PYTHON, '');
});

afterEach(async () => {
  await fs.remove(ROOT).catch(() => {});
});

describe('playback commands', () => {
  it('sends play with everything the server needs, and a seq', async () => {
    const { session, child } = await startedSession();

    const playing = session.play({
      stream: 3, output: 2, from: 900, width: 1280, credits: 4,
    });
    const sent = child.commands().at(-1);
    expect(sent).toMatchObject({
      cmd: 'play', stream: 3, output: 2, from: 900, width: 1280, credits: 4,
    });
    expect(typeof sent.seq).toBe('number');

    child.stdout.write(encode({ type: 'ok', seq: sent.seq, stream: 3, prefetch: 6, from: 900 }));
    await expect(playing).resolves.toEqual({ stream: 3, prefetch: 6, from: 900 });
  });

  it('resolves stop with the last frame the server emitted', async () => {
    const { session, child } = await startedSession();

    const stopping = session.stop(3);
    const sent = child.commands().at(-1);
    expect(sent).toMatchObject({ cmd: 'stop', stream: 3 });

    child.stdout.write(encode({ type: 'ok', seq: sent.seq, stream: 3, n: 941 }));
    await expect(stopping).resolves.toBe(941);
  });

  it('sends credit with no seq, because nothing replies to it', async () => {
    const { session, child } = await startedSession();

    session.credit(3, 2);

    const sent = child.commands().at(-1);
    expect(sent).toEqual({ cmd: 'credit', stream: 3, count: 2 });
    expect(sent.seq).toBeUndefined();
  });
});

describe('pushed frame routing', () => {
  it('sends a pframe to the stream sink, pixels intact', async () => {
    const { session, child } = await startedSession();
    const events: StreamEvent[] = [];
    session.onStream = event => events.push(event);

    const pixels = Buffer.alloc(64, 0x7f);
    child.stdout.write(encode(
      { type: 'pframe', stream: 3, n: 512, output: 2, width: 8, height: 8 },
      pixels,
    ));
    await settle();

    expect(events).toHaveLength(1);
    const event = events[0] as Extract<StreamEvent, { type: 'pframe' }>;
    expect(event).toMatchObject({ type: 'pframe', stream: 3, n: 512, output: 2 });
    expect(event.data.equals(pixels)).toBe(true);
  });

  it('does not let a pushed frame resolve a pending request', async () => {
    const { session, child } = await startedSession();
    session.onStream = () => {};

    const pending = session.frame(7, 1280);
    const sent = child.commands().at(-1);

    // A frame of a stream arrives while a single-frame request is in flight.
    child.stdout.write(encode(
      { type: 'pframe', stream: 3, n: 512, output: 2, width: 8, height: 8 },
      Buffer.alloc(8),
    ));
    await settle();

    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await settle();
    expect(settled).toBe(false);

    // The real answer still lands.
    child.stdout.write(encode(
      { type: 'frame', seq: sent.seq, n: 7, width: 4, height: 2, output: 0 },
      Buffer.alloc(24),
    ));
    await expect(pending).resolves.toMatchObject({ n: 7 });
  });

  it('routes end and stream errors to the sink', async () => {
    const { session, child } = await startedSession();
    const events: StreamEvent[] = [];
    session.onStream = event => events.push(event);

    child.stdout.write(encode({ type: 'end', stream: 3, n: 941 }));
    child.stdout.write(encode({ type: 'error', stream: 3, n: 942, error: 'boom' }));
    await settle();

    expect(events).toEqual([
      { type: 'end', stream: 3, n: 941 },
      { type: 'error', stream: 3, n: 942, error: 'boom' },
    ]);
  });

  it('leaves a seq-carrying reply for its waiter even when it names a stream', async () => {
    const { session, child } = await startedSession();
    const events: StreamEvent[] = [];
    session.onStream = event => events.push(event);

    const playing = session.play({ stream: 3, output: 0, from: 0, width: 640, credits: 1 });
    const sent = child.commands().at(-1);
    // play's own acknowledgement echoes the stream; it is a reply, not a push.
    child.stdout.write(encode({ type: 'ok', seq: sent.seq, stream: 3, prefetch: 4, from: 0 }));

    await expect(playing).resolves.toMatchObject({ stream: 3 });
    expect(events).toHaveLength(0);
  });

  it('drops pushed frames when nothing is listening', async () => {
    const { session, child } = await startedSession();
    expect(session.onStream).toBeUndefined();

    child.stdout.write(encode(
      { type: 'pframe', stream: 3, n: 1, output: 0, width: 2, height: 2 },
      Buffer.alloc(12),
    ));
    await settle();

    // No sink, no throw, and the session is still usable.
    const pending = session.frame(0, 320);
    const sent = child.commands().at(-1);
    child.stdout.write(encode(
      { type: 'frame', seq: sent.seq, n: 0, width: 2, height: 2, output: 0 },
      Buffer.alloc(12),
    ));
    await expect(pending).resolves.toMatchObject({ n: 0 });
  });
});

describe('teardown', () => {
  it('clears the sink when the child exits, so a closed port is never written', async () => {
    const { session, child } = await startedSession();
    const events: StreamEvent[] = [];
    session.onStream = event => events.push(event);

    const pending = session.play({ stream: 1, output: 0, from: 0, width: 640, credits: 4 });
    child.emit('exit', 1, null);

    await expect(pending).rejects.toThrow(/exited/);
    expect(session.onStream).toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it('clears the sink on dispose', async () => {
    const { session } = await startedSession();
    session.onStream = () => {};

    session.dispose();

    expect(session.onStream).toBeUndefined();
  });

  it('swallows a credit written to a dead session', async () => {
    const { session, child } = await startedSession();
    child.emit('exit', 0, null);

    expect(() => session.credit(1, 1)).not.toThrow();
  });
});
