import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { createHash } from 'crypto';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { DownloadError, downloadToFile, setDownloadTestHooks } from './download';
import type { DownloadProgress } from './download';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, hit: number) => void;

const BODY = Buffer.alloc(256 * 1024, 7);

let server: http.Server;
let base = '';
const routes = new Map<string, Handler>();
const hits = new Map<string, number>();
let dir = '';

function route(pathname: string, handler: Handler): string {
  routes.set(pathname, handler);
  return `${base}${pathname}`;
}

function sendBody(res: http.ServerResponse, body: Buffer = BODY): void {
  res.writeHead(200, { 'Content-Length': body.length, 'Content-Type': 'application/octet-stream' });
  res.end(body);
}

async function listDir(): Promise<string[]> {
  return (await fs.readdir(dir)).sort();
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    const hit = (hits.get(pathname) ?? 0) + 1;
    hits.set(pathname, hit);
    const handler = routes.get(pathname);
    if (!handler) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    handler(req, res, hit);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setDownloadTestHooks({ retryBaseDelayMs: 5 });
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(async () => {
  routes.clear();
  hits.clear();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vk-download-test-'));
});

afterEach(async () => {
  server.closeAllConnections();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('downloadToFile', () => {
  it('writes the body to dest and reports progress up to the total', async () => {
    const url = route('/file.7z', (_req, res) => sendBody(res));
    const dest = path.join(dir, 'file.7z');
    const progress: DownloadProgress[] = [];

    await downloadToFile(url, dest, { onProgress: p => progress.push(p), label: 'Test' });

    expect(await fs.readFile(dest)).toEqual(BODY);
    expect(await listDir()).toEqual(['file.7z']);
    expect(progress[0]).toEqual({ received: 0, total: BODY.length });
    expect(progress[progress.length - 1]).toEqual({ received: BODY.length, total: BODY.length });
  });

  it('reports a null total when there is no Content-Length', async () => {
    const url = route('/chunked', (_req, res) => {
      res.writeHead(200);
      res.write(BODY.subarray(0, 1000));
      res.end(BODY.subarray(1000));
    });
    const progress: DownloadProgress[] = [];
    await downloadToFile(url, path.join(dir, 'out'), { onProgress: p => progress.push(p) });
    expect(progress[progress.length - 1]).toEqual({ received: BODY.length, total: null });
  });

  it('follows a chain of redirects', async () => {
    route('/final', (_req, res) => sendBody(res));
    route('/hop2', (_req, res) => { res.writeHead(302, { Location: '/final' }); res.end(); });
    const url = route('/hop1', (_req, res) => { res.writeHead(301, { Location: `${base}/hop2` }); res.end(); });
    const dest = path.join(dir, 'redirected.bin');

    await downloadToFile(url, dest);

    expect(await fs.readFile(dest)).toEqual(BODY);
  });

  it('rejects a 404 as an http error without retrying or leaving files', async () => {
    const url = route('/missing.zip', (_req, res) => { res.writeHead(404); res.end('<html>nope</html>'); });

    const error = await downloadToFile(url, path.join(dir, 'missing.zip'), { label: 'Scripts' })
      .catch(e => e);

    expect(error).toBeInstanceOf(DownloadError);
    expect(error.kind).toBe('http');
    expect(error.status).toBe(404);
    expect(error.url).toBe(url);
    expect(error.message).toContain('Downloading Scripts from 127.0.0.1');
    expect(hits.get('/missing.zip')).toBe(1);
    expect(await listDir()).toEqual([]);
  });

  it('retries a 500 and then succeeds', async () => {
    const url = route('/flaky', (_req, res, hit) => {
      if (hit === 1) {
        res.writeHead(500);
        res.end('oops');
        return;
      }
      sendBody(res);
    });
    const dest = path.join(dir, 'flaky.bin');

    await downloadToFile(url, dest);

    expect(hits.get('/flaky')).toBe(2);
    expect(await fs.readFile(dest)).toEqual(BODY);
  });

  it('gives up on a persistent 503 after the configured retries', async () => {
    const url = route('/down', (_req, res) => { res.writeHead(503); res.end(); });
    const error = await downloadToFile(url, path.join(dir, 'down'), { retries: 2 }).catch(e => e);
    expect(error.kind).toBe('http');
    expect(error.status).toBe(503);
    expect(error.message).toContain('after 3 attempts');
    expect(hits.get('/down')).toBe(3);
    expect(await listDir()).toEqual([]);
  });

  it('times out a body that stalls mid-stream and succeeds on retry', async () => {
    const url = route('/stall', (_req, res, hit) => {
      if (hit === 1) {
        res.writeHead(200, { 'Content-Length': BODY.length });
        res.write(BODY.subarray(0, 1024)); // then nothing, connection held open
        return;
      }
      sendBody(res);
    });
    const dest = path.join(dir, 'stall.bin');

    await downloadToFile(url, dest, { stallTimeoutMs: 200 });

    expect(hits.get('/stall')).toBe(2);
    expect(await fs.readFile(dest)).toEqual(BODY);
  });

  it('reports a stall that never recovers as a timeout naming the wait', async () => {
    const url = route('/stall-forever', (_req, res) => {
      res.writeHead(200, { 'Content-Length': BODY.length });
      res.write(BODY.subarray(0, 1024));
    });
    const error = await downloadToFile(url, path.join(dir, 'x'), { stallTimeoutMs: 150, retries: 0, label: 'FFmpeg' })
      .catch(e => e);
    expect(error.kind).toBe('timeout');
    expect(error.message).toMatch(/^Downloading FFmpeg from 127\.0\.0\.1:\d+ timed out: no data for 150ms\./);
    expect(await listDir()).toEqual([]);
  });

  it('times out when no response headers arrive', async () => {
    const url = route('/silent', () => { /* never answers */ });
    const error = await downloadToFile(url, path.join(dir, 'silent'), { connectTimeoutMs: 150, retries: 1 })
      .catch(e => e);
    expect(error).toBeInstanceOf(DownloadError);
    expect(error.kind).toBe('timeout');
    expect(hits.get('/silent')).toBe(2);
    expect(await listDir()).toEqual([]);
  });

  it('reports a body cut short of its Content-Length as a size error', async () => {
    const url = route('/short', (_req, res) => {
      res.writeHead(200, { 'Content-Length': BODY.length });
      res.write(BODY.subarray(0, 1000), () => res.socket?.destroy());
    });
    const error = await downloadToFile(url, path.join(dir, 'short'), { retries: 0 }).catch(e => e);
    expect(error.kind).toBe('size');
    expect(error.message).toContain('cut short');
    expect(await listDir()).toEqual([]);
  });

  it('rejects a body smaller than minBytes', async () => {
    const url = route('/tiny', (_req, res) => sendBody(res, Buffer.from('<html>error</html>')));
    const error = await downloadToFile(url, path.join(dir, 'tiny.7z'), { minBytes: 1024 }).catch(e => e);
    expect(error.kind).toBe('size');
    expect(hits.get('/tiny')).toBe(1);
    expect(await listDir()).toEqual([]);
  });

  it('accepts a matching sha256 and rejects a mismatch', async () => {
    const url = route('/hashed', (_req, res) => sendBody(res));
    const good = createHash('sha256').update(BODY).digest('hex');

    await downloadToFile(url, path.join(dir, 'good'), { expectedSha256: good.toUpperCase() });
    expect(await listDir()).toEqual(['good']);

    const error = await downloadToFile(url, path.join(dir, 'bad'), { expectedSha256: '0'.repeat(64) }).catch(e => e);
    expect(error.kind).toBe('checksum');
    expect(await listDir()).toEqual(['good']);
  });

  it('stops on an external abort without retrying', async () => {
    const url = route('/slow', (_req, res) => {
      res.writeHead(200, { 'Content-Length': BODY.length });
      res.write(BODY.subarray(0, 1024));
    });
    const controller = new AbortController();
    const promise = downloadToFile(url, path.join(dir, 'slow'), {
      signal: controller.signal,
      onProgress: p => { if (p.received > 0) controller.abort(); },
    });

    const error = await promise.catch(e => e);
    expect(error.kind).toBe('aborted');
    expect(hits.get('/slow')).toBe(1);
    expect(await listDir()).toEqual([]);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const url = route('/never', (_req, res) => sendBody(res));
    const error = await downloadToFile(url, path.join(dir, 'never'), { signal: AbortSignal.abort() }).catch(e => e);
    expect(error.kind).toBe('aborted');
    expect(hits.get('/never')).toBeUndefined();
  });

  it('leaves an existing dest intact until the new file is complete', async () => {
    const dest = path.join(dir, 'existing.bin');
    await fs.writeFile(dest, 'old content');

    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const url = route('/replace', (_req, res) => {
      res.writeHead(200, { 'Content-Length': BODY.length });
      res.write(BODY.subarray(0, 1024));
      void gate.then(() => res.end(BODY.subarray(1024)));
    });

    let midway: string | null = null;
    let partSeen = false;
    const promise = downloadToFile(url, dest, {
      onProgress: async p => {
        if (p.received > 0 && midway === null) {
          midway = await fs.readFile(dest, 'utf8');
          partSeen = (await fs.readdir(dir)).includes('existing.bin.part');
          release();
        }
      },
    });
    await promise;

    expect(midway).toBe('old content');
    expect(partSeen).toBe(true);
    expect(await fs.readFile(dest)).toEqual(BODY);
    expect(await listDir()).toEqual(['existing.bin']);
  });

  it('keeps the old dest when the replacement download fails', async () => {
    const dest = path.join(dir, 'keep.bin');
    await fs.writeFile(dest, 'old content');
    const url = route('/fails', (_req, res) => { res.writeHead(404); res.end(); });
    await downloadToFile(url, dest).catch(() => undefined);
    expect(await fs.readFile(dest, 'utf8')).toBe('old content');
    expect(await listDir()).toEqual(['keep.bin']);
  });

  it('turns an unreachable server into a network error', async () => {
    // Bind and release a port so nothing is listening on it.
    const probe = http.createServer();
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>(resolve => probe.close(() => resolve()));

    const error = await downloadToFile(`http://127.0.0.1:${port}/x`, path.join(dir, 'x'), { retries: 0 }).catch(e => e);
    expect(error.kind).toBe('network');
    expect(error.message).toContain('the connection was refused');
  });
});
