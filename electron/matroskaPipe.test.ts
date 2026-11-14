import { describe, expect, it } from 'vitest';
import { Readable, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import { MatroskaPipe } from './matroskaPipe';
async function pass(chunks: Buffer[]) {
  const collected: Buffer[] = [];
  await pipeline(Readable.from(chunks), new MatroskaPipe(), new Writable({ write(chunk, _encoding, done) { collected.push(chunk); done(); } }));
  return Buffer.concat(collected);
}
describe('Matroska binary transport', () => {
  it('preserves video exactly when the EBML header is split across chunks', async () => {
    const header = Buffer.from('1a45dfa3', 'hex'); const data=Buffer.alloc(1024*1024, 137);
    expect(await pass([header.subarray(0,1),header.subarray(1,3),Buffer.concat([header.subarray(3),data])])).toEqual(Buffer.concat([header,data]));
  });
  it('identifies diagnostics contaminating stdout instead of forwarding them as video', async () => {
    await expect(pass([Buffer.from('[vk-build] compiling engine\n')])).rejects.toThrow('diagnostics to stdout');
  });
  it('reports an upstream failure producing no video', async () => {
    await expect(pass([])).rejects.toThrow('before producing');
    await expect(pass([Buffer.from([0x1a,0x45])])).rejects.toThrow('before producing');
  });
});
