import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', async () => {
  const p = await import('path');
  const o = await import('os');
  const root = p.join(o.tmpdir(), `vk-preview-test-${process.pid}`);
  return { app: { isPackaged: false, getAppPath: () => root, getPath: () => root } };
});

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { FrameReader } from './previewSession';

interface Reply {
  header: Record<string, any>;
  payload: Buffer | null;
}

/** Builds one wire reply: uint32 header length, header JSON, payload. */
function encode(header: Record<string, unknown>, payload = Buffer.alloc(0)): Buffer {
  const body = Buffer.from(JSON.stringify({ ...header, bytes: payload.length }), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  return Buffer.concat([length, body, payload]);
}

function collect(chunks: Buffer[]): Reply[] {
  const replies: Reply[] = [];
  const reader = new FrameReader(reply => replies.push(reply));
  for (const chunk of chunks) reader.push(chunk);
  return replies;
}

describe('FrameReader', () => {
  const pixels = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]);

  it('reads a frame delivered in one chunk', () => {
    const replies = collect([encode({ type: 'frame', n: 4 }, pixels)]);

    expect(replies).toHaveLength(1);
    expect(replies[0].header.n).toBe(4);
    expect(replies[0].payload).toEqual(pixels);
  });

  it('reads a payload-free reply', () => {
    const replies = collect([encode({ type: 'ok', seq: 2 })]);

    expect(replies).toHaveLength(1);
    expect(replies[0].payload).toBeNull();
  });

  // The pipe splits wherever it likes. A reader that only works on tidy
  // boundaries corrupts every frame after the first ragged one, so drive it
  // one byte at a time — the worst case a pipe can produce.
  it('survives being fed one byte at a time', () => {
    const wire = encode({ type: 'frame', n: 7 }, pixels);
    const chunks = Array.from({ length: wire.length }, (_, i) => wire.subarray(i, i + 1));

    const replies = collect(chunks);

    expect(replies).toHaveLength(1);
    expect(replies[0].header.n).toBe(7);
    expect(replies[0].payload).toEqual(pixels);
  });

  it('reads several replies packed into one chunk', () => {
    const wire = Buffer.concat([
      encode({ type: 'frame', n: 1 }, pixels),
      encode({ type: 'ok', seq: 9 }),
      encode({ type: 'frame', n: 2 }, pixels),
    ]);

    const replies = collect([wire]);

    expect(replies.map(r => r.header.type)).toEqual(['frame', 'ok', 'frame']);
    expect(replies[2].header.n).toBe(2);
  });

  it('reads replies split across an arbitrary boundary', () => {
    const wire = Buffer.concat([
      encode({ type: 'frame', n: 1 }, pixels),
      encode({ type: 'frame', n: 2 }, pixels),
    ]);

    for (let split = 1; split < wire.length; split++) {
      const replies = collect([wire.subarray(0, split), wire.subarray(split)]);
      expect(replies.map(r => r.header.n)).toEqual([1, 2]);
      expect(replies[1].payload).toEqual(pixels);
    }
  });

  it('keeps a large payload intact', () => {
    const large = Buffer.alloc(1280 * 720 * 3);
    large.fill(0xab);
    large[0] = 1;
    large[large.length - 1] = 2;

    // Chunked the way a real pipe delivers megabytes.
    const wire = encode({ type: 'frame', n: 0 }, large);
    const chunks: Buffer[] = [];
    for (let i = 0; i < wire.length; i += 65536) chunks.push(wire.subarray(i, i + 65536));

    const replies = collect(chunks);

    expect(replies).toHaveLength(1);
    expect(replies[0].payload!.length).toBe(large.length);
    expect(replies[0].payload!.equals(large)).toBe(true);
  });
});
