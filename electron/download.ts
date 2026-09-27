// electron/download.ts
//
// The one way this app downloads a file to disk.
//
// Every downloader used to be written by hand, and each got some of the same
// things wrong: resolving on the write stream's 'finish' while the descriptor
// was still open (7-Zip then saw "0 bytes, file in use"), no timeout so a
// stalled connection left the UI at "Downloading... N%" forever, no handler
// for a socket error mid-body so the promise never settled, error pages saved
// under an archive's name, and a single redirect followed. This module is
// where those are handled once.
//
// A download goes to `${dest}.part` and is renamed onto dest only after the
// handle is closed and the bytes are checked, so dest is either the old file
// or the complete new one - never something in between.

import * as path from 'path';
import * as fs from 'fs/promises';
import { createHash } from 'crypto';
import { logger } from './logger';

export interface DownloadProgress { received: number; total: number | null }

export interface DownloadOptions {
  /** Abort if no response headers within this long. Default 30_000 */
  connectTimeoutMs?: number;
  /** Abort if no bytes arrive for this long mid-body. Default 60_000 */
  stallTimeoutMs?: number;
  /** Extra attempts after the first, for network errors, stalls, 5xx and 429. Never for other 4xx. Default 3 */
  retries?: number;
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
  /** Reject a body smaller than this (an error page saved under an archive name). */
  minBytes?: number;
  expectedSha256?: string;
  /** Short name for messages/logs, e.g. "FFmpeg" */
  label?: string;
}

export type DownloadErrorKind = 'http' | 'timeout' | 'network' | 'size' | 'checksum' | 'aborted';

export class DownloadError extends Error {
  kind: DownloadErrorKind;
  status?: number;
  url: string;

  constructor(message: string, kind: DownloadErrorKind, url: string, status?: number) {
    super(message);
    this.name = 'DownloadError';
    this.kind = kind;
    this.url = url;
    if (status !== undefined) {
      this.status = status;
    }
  }
}

/** The slice of fetch this module uses; Electron's net.fetch and Node's fetch both fit it. */
export type FetchLike = (url: string, init: { signal: AbortSignal; redirect: 'follow' }) => Promise<Response>;

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_STALL_TIMEOUT_MS = 60_000;
const DEFAULT_RETRIES = 3;
const PROGRESS_INTERVAL_MS = 100;

let fetchOverride: FetchLike | null = null;
let retryBaseDelayMs = 1000;

/**
 * Lets tests supply the transport and shorten the backoff. Passing null for
 * fetchImpl goes back to the normal choice of transport.
 */
export function setDownloadTestHooks(hooks: { fetchImpl?: FetchLike | null; retryBaseDelayMs?: number }): void {
  if (hooks.fetchImpl !== undefined) {
    fetchOverride = hooks.fetchImpl;
  }
  if (hooks.retryBaseDelayMs !== undefined) {
    retryBaseDelayMs = hooks.retryBaseDelayMs;
  }
}

/**
 * Electron's net.fetch goes through Chromium's network stack, which honours
 * the system proxy settings; Node's fetch ignores them, so on a machine that
 * can only reach the internet through a proxy it simply fails. Electron is
 * resolved here rather than imported so this module still loads under vitest
 * and plain Node, where require('electron') either throws or returns the path
 * to the binary. net.fetch is only usable once the app is ready.
 */
function resolveTransport(): { fetch: FetchLike; name: string } {
  if (fetchOverride) {
    return { fetch: fetchOverride, name: 'test transport' };
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron');
    const net = electron?.net;
    const app = electron?.app;
    if (net && typeof net.fetch === 'function' && app?.isReady?.()) {
      return { fetch: (url, init) => net.fetch(url, init), name: 'Electron net' };
    }
  } catch {
    // Not running inside Electron's main process.
  }
  return { fetch: (url, init) => fetch(url, init), name: 'Node fetch' };
}

/** Why one attempt failed, before it is turned into the message the user sees. */
interface Failure {
  kind: DownloadErrorKind;
  /** Worth another attempt: the same request could plausibly succeed. */
  transient: boolean;
  status?: number;
  timeout?: 'connect' | 'stall';
  timeoutMs?: number;
  detail?: string;
  received?: number;
  total?: number | null;
  truncated?: boolean;
}

class AttemptFailed extends Error {
  constructor(readonly failure: Failure) {
    super(failure.detail ?? failure.kind);
  }
}

/**
 * Resolves only once the file is fully written, closed and renamed into place
 * at `dest`. Network, HTTP, size and checksum failures reject with a
 * DownloadError; a filesystem failure (disk full, dest locked) rejects with the
 * filesystem's own error. Either way no .part file is left behind.
 */
export async function downloadToFile(url: string, dest: string, options: DownloadOptions = {}): Promise<void> {
  const host = hostOf(url);
  const label = options.label ?? (path.basename(safePathname(url)) || host);
  const retries = Math.max(0, options.retries ?? DEFAULT_RETRIES);
  const partPath = `${dest}.part`;
  const transport = resolveTransport();

  await fs.mkdir(path.dirname(dest), { recursive: true });
  logger.info(`Downloading ${label} from ${url} (${transport.name})`);

  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      if (options.signal?.aborted) {
        throw new AttemptFailed({ kind: 'aborted', transient: false });
      }
      await attemptOnce(url, partPath, options, transport.fetch);
      await renameIntoPlace(partPath, dest);
      logger.info(`Downloaded ${label} to ${dest}`);
      return;
    } catch (error) {
      await fs.rm(partPath, { force: true }).catch(() => undefined);
      if (!(error instanceof AttemptFailed)) {
        throw error;
      }
      const failure = error.failure;
      if (!failure.transient || attempt > retries) {
        const message = describeFailure(failure, label, host, attempt);
        logger.error(`${message} [${url}]`);
        throw new DownloadError(message, failure.kind, url, failure.status);
      }
      const delay = retryBaseDelayMs * 3 ** (attempt - 1);
      logger.warn(
        `${label}: attempt ${attempt} of ${retries + 1} failed (${summarize(failure)}); retrying in ${formatSeconds(delay)}`,
      );
      try {
        await sleep(delay, options.signal);
      } catch {
        const message = describeFailure({ kind: 'aborted', transient: false }, label, host, attempt);
        throw new DownloadError(message, 'aborted', url);
      }
    }
  }
}

async function attemptOnce(
  url: string,
  partPath: string,
  options: DownloadOptions,
  fetchImpl: FetchLike,
): Promise<void> {
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut: 'connect' | 'stall' | null = null;
  let timer: NodeJS.Timeout | undefined;

  const arm = (which: 'connect' | 'stall', ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = which;
      controller.abort();
    }, ms);
  };
  const onExternalAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });

  // Anything the transport throws is classified here: the external signal
  // wins, then our own timers, and whatever remains is the network's fault.
  const classify = (error: unknown, received: number, total: number | null): AttemptFailed => {
    if (options.signal?.aborted) {
      return new AttemptFailed({ kind: 'aborted', transient: false });
    }
    if (timedOut) {
      return new AttemptFailed({
        kind: 'timeout',
        transient: true,
        timeout: timedOut,
        timeoutMs: timedOut === 'connect' ? connectTimeoutMs : stallTimeoutMs,
        detail: `${timedOut} timeout`,
      });
    }
    // A connection dropped part way through a body of known length is the
    // same fault a short body would be, and reporting it as a size problem
    // tells the user what they actually got.
    if (total !== null && received < total) {
      return new AttemptFailed({ kind: 'size', transient: true, truncated: true, received, total, detail: networkDetail(error) });
    }
    return new AttemptFailed({ kind: 'network', transient: true, detail: networkDetail(error) });
  };

  const hash = options.expectedSha256 ? createHash('sha256') : null;
  let received = 0;
  let total: number | null = null;
  let handle: fs.FileHandle | undefined;
  const progress = progressReporter(options.onProgress);

  try {
    arm('connect', connectTimeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' });
    } catch (error) {
      throw classify(error, 0, null);
    }
    clearTimeout(timer);

    if (!response.ok) {
      // Drain nothing we will not use; cancelling releases the connection.
      await response.body?.cancel().catch(() => undefined);
      const status = response.status;
      throw new AttemptFailed({ kind: 'http', status, transient: status >= 500 || status === 429, detail: `HTTP ${status}` });
    }

    total = contentLength(response);
    progress.report({ received: 0, total }, true);

    handle = await fs.open(partPath, 'w');
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        // The stall timer covers only the wait for the network, not our own
        // disk writes, so a slow disk is never mistaken for a dead connection.
        arm('stall', stallTimeoutMs);
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (error) {
          throw classify(error, received, total);
        }
        clearTimeout(timer);
        if (chunk.done) {
          break;
        }
        hash?.update(chunk.value);
        await handle.write(chunk.value);
        received += chunk.value.byteLength;
        progress.report({ received, total }, false);
      }
    }
    progress.report({ received, total }, true);
  } finally {
    clearTimeout(timer);
    progress.cancel();
    options.signal?.removeEventListener('abort', onExternalAbort);
    // Awaited, and before anything looks at the file: the old downloaders
    // settled on 'finish', which fires while the descriptor is still open.
    await handle?.close();
  }

  if (total !== null && received !== total) {
    throw new AttemptFailed({ kind: 'size', transient: true, truncated: true, received, total });
  }
  if (options.minBytes !== undefined && received < options.minBytes) {
    // Retrying rarely helps: a server that answered 200 with a stub page
    // will usually answer the same way again.
    throw new AttemptFailed({ kind: 'size', transient: false, received, total });
  }
  if (hash && options.expectedSha256) {
    const actual = hash.digest('hex');
    if (actual !== options.expectedSha256.toLowerCase()) {
      // Not retried: a mismatch is almost always a pinned digest that no
      // longer matches what the server publishes, and downloading it again
      // would only cost the user the bandwidth twice.
      throw new AttemptFailed({ kind: 'checksum', transient: false, detail: `sha256 ${actual}` });
    }
  }
}

/**
 * A plain rename replaces dest in one step. Windows refuses while another
 * handle has either file open, and a virus scanner opening the brand-new
 * .part is exactly that, so it is retried for a moment.
 */
async function renameIntoPlace(partPath: string, dest: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(partPath, dest);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 8 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 100 * attempt));
    }
  }
}

/**
 * Content-Length describes the bytes on the wire. When the body is
 * content-encoded, fetch hands us the decoded bytes, so the header cannot be
 * compared against them and is ignored.
 */
function contentLength(response: Response): number | null {
  const encoding = response.headers.get('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') {
    return null;
  }
  const header = response.headers.get('content-length');
  if (header === null) {
    return null;
  }
  const value = Number(header);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Calls back at most every PROGRESS_INTERVAL_MS. A report that falls inside
 * the interval is held and delivered when it ends rather than dropped, so a
 * connection that delivers one chunk and then goes quiet still shows it.
 */
function progressReporter(onProgress: DownloadOptions['onProgress']) {
  let last = 0;
  let pending: DownloadProgress | null = null;
  let timer: NodeJS.Timeout | undefined;

  const deliver = (value: DownloadProgress) => {
    last = Date.now();
    pending = null;
    try {
      onProgress?.(value);
    } catch (error) {
      // A broken progress handler must not fail the download it is watching.
      logger.warn('Download progress handler threw:', error);
    }
  };

  return {
    report(value: DownloadProgress, force: boolean) {
      if (!onProgress) {
        return;
      }
      const wait = PROGRESS_INTERVAL_MS - (Date.now() - last);
      if (force || wait <= 0) {
        clearTimeout(timer);
        timer = undefined;
        deliver(value);
        return;
      }
      pending = value;
      timer ??= setTimeout(() => {
        timer = undefined;
        if (pending) {
          deliver(pending);
        }
      }, wait);
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
      pending = null;
    },
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const NETWORK_CODES: Record<string, string> = {
  ENOTFOUND: 'the server name could not be looked up',
  EAI_AGAIN: 'the server name could not be looked up',
  ERR_NAME_NOT_RESOLVED: 'the server name could not be looked up',
  ECONNREFUSED: 'the connection was refused',
  ERR_CONNECTION_REFUSED: 'the connection was refused',
  ECONNRESET: 'the connection was reset',
  ERR_CONNECTION_RESET: 'the connection was reset',
  ETIMEDOUT: 'the connection timed out',
  ERR_CONNECTION_TIMED_OUT: 'the connection timed out',
  ERR_INTERNET_DISCONNECTED: 'the computer is offline',
  ERR_PROXY_CONNECTION_FAILED: 'the proxy could not be reached',
  UND_ERR_SOCKET: 'the connection was closed unexpectedly',
};

/**
 * Node's fetch reports "fetch failed" with the useful part in `cause`;
 * Electron's net reports "net::ERR_...". Either is reduced to a short phrase.
 */
function networkDetail(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code ?? (error as { code?: string })?.code;
  if (code && NETWORK_CODES[code]) {
    return NETWORK_CODES[code];
  }
  const message = cause?.message ?? (error instanceof Error ? error.message : String(error));
  const netCode = /net::(ERR_[A-Z_]+)/.exec(message)?.[1];
  if (netCode) {
    return NETWORK_CODES[netCode] ?? `the connection failed (${netCode})`;
  }
  if (/terminated|other side closed/i.test(message)) {
    return 'the connection was closed unexpectedly';
  }
  return `the connection failed (${code ?? message})`;
}

function describeFailure(failure: Failure, label: string, host: string, attempts: number): string {
  const where = `Downloading ${label} from ${host}`;
  const tries = attempts > 1 ? ` after ${attempts} attempts` : '';
  switch (failure.kind) {
    case 'aborted':
      return `Downloading ${label} was cancelled.`;
    case 'timeout':
      return failure.timeout === 'connect'
        ? `${where} timed out${tries}: no response for ${formatSeconds(failure.timeoutMs ?? 0)}. Check your connection or proxy settings and retry.`
        : `${where} timed out${tries}: no data for ${formatSeconds(failure.timeoutMs ?? 0)}. Check your connection and retry.`;
    case 'network':
      return `${where} failed${tries}: ${failure.detail}. Check your connection or proxy settings and retry.`;
    case 'http':
      return `${where} failed${tries}: the server answered HTTP ${failure.status}. ${httpHint(failure.status ?? 0, host)}`;
    case 'size':
      if (failure.truncated) {
        return `${where} was cut short${tries}: received ${formatBytes(failure.received ?? 0)} of ${formatBytes(failure.total ?? 0)}. Check your connection and retry.`;
      }
      return `${where} returned only ${formatBytes(failure.received ?? 0)}, which is not the expected file (probably an error page). Try again later, and report it if it keeps happening.`;
    case 'checksum':
      return `${where} produced a file that does not match its expected checksum, so it was discarded. Retry, and report it if it happens again.`;
  }
}

function httpHint(status: number, host: string): string {
  if (status === 404 || status === 410) {
    return 'The file is no longer there; update Vapourkit or report this.';
  }
  if (status === 429 || status >= 500) {
    return 'The server is busy or having trouble; try again in a few minutes.';
  }
  if (status === 401 || status === 403 || status === 407) {
    return `Access was refused; if you are behind a proxy or firewall, allow ${host}.`;
  }
  return 'Report this if it keeps happening.';
}

/** The one-line reason logged with each retry. */
function summarize(failure: Failure): string {
  switch (failure.kind) {
    case 'timeout':
      return failure.timeout === 'connect' ? 'no response' : 'stalled';
    case 'size':
      return `got ${failure.received} of ${failure.total} bytes`;
    default:
      return failure.detail ?? failure.kind;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

function formatSeconds(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 100) / 10}s` : `${ms}ms`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} bytes`;
}
