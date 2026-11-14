/** Track ordinals are per type, so "first audio" can be applied across a batch. */
export interface ContainerTrack {
  type: 'audio' | 'subtitle';
  index: number;
  ordinal: number;
  codec: string;
  language?: string;
  title?: string;
  isDefault: boolean;
  forced: boolean;
}
export function parseContainerTracks(output: string): ContainerTrack[] {
  const tracks: ContainerTrack[] = [];
  let current: ContainerTrack | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (/^\s*Stream #/.test(line)) {
      current = undefined;
      const match = /^\s*Stream #0:(\d+)(?:\[[^\]]+\])?(?:\(([^)]+)\))?[^\n]*?:\s*(Audio|Subtitle):\s*([^,\s]+)/i.exec(line);
      if (!match) continue;
      const type = match[3].toLowerCase() === 'audio' ? 'audio' : 'subtitle';
      current = { type, index: Number(match[1]), ordinal: tracks.filter(t => t.type === type).length,
        codec: match[4], ...(match[2] ? { language: match[2] } : {}),
        isDefault: /\(default\)/i.test(line), forced: /\(forced\)/i.test(line) };
      tracks.push(current);
    } else if (current) {
      const title = /^\s+title\s*:\s*(.+)$/i.exec(line);
      if (title) current.title = title[1].trim();
    }
  }
  return tracks;
}

/** undefined means keep all; an empty list means remove all tracks of this type. */
export function normalizeTrackSelection(value: unknown): number[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 64 || !value.every(n => Number.isInteger(n) && n >= 0 && n < 1024)) return null;
  return [...new Set<number>(value)].sort((a, b) => a - b);
}
