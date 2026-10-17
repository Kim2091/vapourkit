// electron/archive.ts
import * as fs from 'fs-extra';
import * as _7z from '7zip-min';

/** What 7-Zip prints when the archive is still held open, by a download or a virus scan. */
export function isArchiveLockedError(message: string): boolean {
  return message.includes('Can not open the file as archive')
    || message.includes('The process cannot access the file because it is being used by another process')
    || message.includes("Can't open as archive");
}

export interface Extract7zOptions {
  /** Leaves files that already exist in the destination as they are (7-Zip -aos). */
  skipExisting?: boolean;
  /** Attempts in all, for an archive that is still locked. */
  attempts?: number;
  retryDelayMs?: number;
  /** Called before each wait for a locked archive. */
  onLockedRetry?: (attempt: number, attempts: number) => void;
}

/**
 * Extracts an archive with 7-Zip, retrying while the archive is locked. Any
 * other failure, or a lock that outlasts the attempts, is thrown as 7-Zip
 * reported it.
 */
export async function extract7z(archivePath: string, outputPath: string, options: Extract7zOptions = {}): Promise<void> {
  const attempts = options.attempts ?? 5;
  const retryDelayMs = options.retryDelayMs ?? 2000;
  await fs.ensureDir(outputPath);

  for (let attempt = 1; ; attempt++) {
    try {
      if (options.skipExisting) {
        await _7z.cmd(['x', archivePath, `-o${outputPath}`, '-aos', '-y']);
      } else {
        await _7z.unpack(archivePath, outputPath);
      }
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= attempts || !isArchiveLockedError(message)) throw error;
      options.onLockedRetry?.(attempt, attempts);
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
  }
}
