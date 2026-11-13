import { Transform, type TransformCallback } from 'stream';

const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
/** Inspect only the stream prefix; valid video passes through with backpressure. */
export class MatroskaPipe extends Transform {
  private prefix = Buffer.alloc(0);
  private verified = false;
  _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    if (this.verified) { done(null, chunk); return; }
    const needed = 4 - this.prefix.length;
    this.prefix = Buffer.concat([this.prefix, chunk.subarray(0, needed)]);
    if (this.prefix.length < 4) { done(); return; }
    if (!this.prefix.equals(EBML)) {
      const sample = Buffer.concat([this.prefix, chunk.subarray(needed, needed + 156)]).toString('utf8').replace(/[\x00-\x1f]/g, ' ');
      done(new Error(`VapourSynth output is not a Matroska video stream. A script or subprocess may have written diagnostics to stdout. Prefix: ${sample}`));
      return;
    }
    this.verified = true;
    this.push(this.prefix); this.prefix = Buffer.alloc(0);
    done(null, chunk.subarray(needed));
  }
  _flush(done: TransformCallback): void {
    done(this.verified ? undefined : new Error('VapourSynth ended before producing a complete Matroska header. Check the preceding VapourSynth error.'));
  }
}
