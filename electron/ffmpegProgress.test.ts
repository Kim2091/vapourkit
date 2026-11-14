import { describe, expect, it } from 'vitest';
import { FFmpegProgress } from './ffmpegProgress';

describe('structured FFmpeg progress', () => {
  it('handles split blocks, multiple updates in a chunk, and unrelated stderr', () => {
    const records: unknown[] = [];
    const parser = new FFmpegProgress(p => records.push(p));
    parser.push('Encoder warning: low memory\nfra');
    parser.push('me=17\nfps=3.4\nprogress=continue\nframe=24\nfps=4.1\npro');
    parser.push('gress=end'); parser.flush();
    expect(records).toEqual([{frame:17,fps:3.4,ended:false},{frame:24,fps:4.1,ended:true}]);
  });
  it('does not invent frames from human diagnostics or malformed blocks', () => {
    const records: unknown[] = []; const parser = new FFmpegProgress(p => records.push(p));
    parser.push('frame=not a number\nfps=N/A\nprogress=continue\nframe= 80 fps=4.0 q=20\nprogress=end\n');
    expect(records).toEqual([]);
  });
});
