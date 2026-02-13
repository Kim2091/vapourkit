// electron/queueItemLogger.ts
import * as path from 'path';
import * as fs from 'fs-extra';
import { PATHS } from './constants';

const QUEUE_LOGS_DIR = path.join(PATHS.APP_DATA, 'logs', 'queue');

/**
 * Per-queue-item logger that writes a dedicated log file for each processing run.
 * Log files are stored in data/logs/queue/ with the naming convention:
 *   <sanitized-video-name>_<timestamp>.log
 */
export class QueueItemLogger {
  private logPath: string;
  private stream: fs.WriteStream | null = null;

  constructor(videoName: string) {
    const sanitized = videoName
      .replace(/\.[^/.]+$/, '') // remove extension
      .replace(/[<>:"/\\|?*]/g, '_') // sanitize for filesystem
      .substring(0, 80); // limit length
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const filename = `${sanitized}_${timestamp}.log`;
    this.logPath = path.join(QUEUE_LOGS_DIR, filename);
  }

  /**
   * Opens the log file for writing
   */
  async open(): Promise<void> {
    await fs.ensureDir(QUEUE_LOGS_DIR);
    this.stream = fs.createWriteStream(this.logPath, { flags: 'w', encoding: 'utf-8' });
    this.write(`Queue item log started at ${new Date().toISOString()}`);
    this.write('='.repeat(80));
  }

  /**
   * Writes a timestamped line to the per-item log file
   */
  write(message: string): void {
    if (!this.stream) return;
    const ts = new Date().toISOString().replace('T', ' ').slice(0, -1);
    this.stream.write(`[${ts}] ${message}\n`);
  }

  /**
   * Writes an error line
   */
  error(message: string): void {
    this.write(`[ERROR] ${message}`);
  }

  /**
   * Closes the log file stream
   */
  close(): void {
    if (this.stream) {
      this.write('='.repeat(80));
      this.write(`Queue item log ended at ${new Date().toISOString()}`);
      this.stream.end();
      this.stream = null;
    }
  }

  /**
   * Returns the full path to this item's log file
   */
  getLogPath(): string {
    return this.logPath;
  }

  /**
   * Returns the directory where queue logs are stored
   */
  static getQueueLogsDir(): string {
    return QUEUE_LOGS_DIR;
  }
}
