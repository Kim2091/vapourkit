import { LineSplitter } from './lineSplitter';

export interface EncodingProgress { frame: number; fps: number; ended: boolean; }
/** FFmpeg -progress blocks, independent of human stats formatting/chunk boundaries. */
export class FFmpegProgress {
  private fields: Record<string, string> = {};
  private lines = new LineSplitter(line => {
    const match = /^(frame|fps|progress)=(.*)$/.exec(line);
    if (!match) return;
    this.fields[match[1]] = match[2].trim();
    if (match[1] !== 'progress') return;
    const frame = Number(this.fields.frame), fps = Number(this.fields.fps);
    if (Number.isInteger(frame) && frame >= 0) this.receive({ frame, fps: Number.isFinite(fps) && fps >= 0 ? fps : 0, ended: match[2].trim() === 'end' });
    this.fields = {};
  });
  constructor(private receive: (progress: EncodingProgress) => void) {}
  push(text: string): void { this.lines.push(text); }
  flush(): void { this.lines.flush(); }
}
