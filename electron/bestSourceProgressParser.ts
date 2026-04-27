const PROGRESS_LINE = /VideoSource track #\d+ index progress (\d+)%/g;

/**
 * Parses BestSource progress lines from a stderr chunk.
 * Returns the percentages extracted (in order). Empty array if no matches.
 * Percentages are clamped to [0, 100].
 */
export function parseBestSourceProgress(chunk: string): number[] {
  const out: number[] = [];
  PROGRESS_LINE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PROGRESS_LINE.exec(chunk)) !== null) {
    const raw = parseInt(match[1], 10);
    if (Number.isFinite(raw)) {
      out.push(Math.max(0, Math.min(100, raw)));
    }
  }
  return out;
}
