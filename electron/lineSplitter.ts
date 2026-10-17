// electron/lineSplitter.ts

/** Splits a stream into lines, holding back a partial last line until more arrives. */
export class LineSplitter {
  private pending = '';

  constructor(private readonly onLine: (line: string) => void) {}

  /** Emits every complete line in `chunk`, trimmed; blank lines are skipped. */
  push(chunk: string): void {
    const parts = (this.pending + chunk).split(/\r\n|\r|\n/);
    this.pending = parts.pop() ?? '';
    for (const part of parts) this.emit(part);
  }

  /** Emits the partial last line, for when the stream has ended. */
  flush(): void {
    const rest = this.pending;
    this.pending = '';
    this.emit(rest);
  }

  private emit(line: string): void {
    const trimmed = line.trim();
    if (trimmed) this.onLine(trimmed);
  }
}
