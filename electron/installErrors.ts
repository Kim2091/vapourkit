// electron/installErrors.ts
//
// Turns the raw output of a failed install into one sentence a user can act on.
//
// pip, 7-Zip and Windows each report the same handful of failures in their own
// words, and none of those words reach the user when all we show is "exit code
// 1". A full disk, a DLL held open by antivirus and an unreachable package
// index all need different fixes, and the fix is usually on the user's side of
// the screen, so the summary names it. The evidence travels alongside so the
// details area can show the lines the verdict was drawn from.
//
// Pure string work: no fs, no logger, nothing to mock, so every rule here can
// be tested against real output captured from the field.

export type InstallErrorKind =
  | 'disk-full' | 'access-denied' | 'file-in-use' | 'path-too-long' | 'network' | 'timeout' | 'ssl' | 'proxy'
  | 'pip-missing' | 'pip-metadata' | 'no-matching-distribution' | 'dependency-conflict' | 'python-missing' | 'unknown';

export interface ClassifiedInstallError {
  kind: InstallErrorKind;
  /** One sentence saying what went wrong and what to do, for the UI */
  summary: string;
  /** The lines of output that show it, trimmed (<= ~15 lines), for an expandable details area */
  evidence: string;
}

interface Rule {
  kind: Exclude<InstallErrorKind, 'unknown'>;
  patterns: RegExp[];
  /**
   * pip retries a flaky download and often succeeds on the next attempt, so a
   * "WARNING: Retrying ... timed out" line on its own does not mean the
   * network is why the install failed. Such a line only counts when pip also
   * gave up on the index (see indexUnreachable).
   */
  retryWarningsAreWeak?: boolean;
}

// Checked in order, and the first rule with any matching line wins. The order
// is the point: one failure drags several symptoms into the output with it.
//
// - A full disk surfaces as a generic OSError, so it is checked before
//   anything that could claim an OSError.
// - pip adds its long-path hint to what is otherwise a plain "No such file",
//   and Windows can call an over-long path "access denied", so length first.
// - A missing pip is a Python that ran; a missing Python is one that did not.
//   "No module named pip" is the more specific of the two.
// - A file held open is often also reported as access denied, and "in use"
//   is the one that says what to do about it.
// - An interrupted install is local state; any network noise around it is
//   incidental, so it sits ahead of the network rules.
// - SSL, proxy and timeout failures are all wrapped in urllib3's generic
//   "Max retries exceeded", so they must be tried before plain network.
// - When the index cannot be reached pip goes on to say no version matches,
//   which is true but misleading, so every network rule beats that one.
const RULES: Rule[] = [
  {
    kind: 'disk-full',
    patterns: [
      /\[Errno 28\]/,
      /No space left on device/i,
      /\bENOSPC\b/,
      /not enough space on the disk/i,
      /\[WinError 112\]/,
    ],
  },
  {
    kind: 'path-too-long',
    patterns: [
      /\[WinError 206\]/,
      /filename or extension is too long/i,
      /\bENAMETOOLONG\b/,
      /does not have Windows Long Path support enabled/i,
      /\[Errno 36\] File name too long/i,
    ],
  },
  {
    kind: 'pip-missing',
    patterns: [
      /No module named '?pip'?(?:\s|$|;|\.)/i,
      /No module named '?pip\.__main__'?/i,
    ],
  },
  {
    kind: 'python-missing',
    patterns: [
      // Node's spawn error when the interpreter is gone, e.g.
      // "spawn C:\...\data\python\python.exe ENOENT". Anchored on the
      // executable itself: an ENOENT for some file *under* the python folder
      // is a damaged package, not a missing interpreter.
      /spawn .*\bpython\w*(?:\.exe)?\s+ENOENT/i,
      /ENOENT.*\bpython\w*\.exe\b/i,
      /'python\w*(?:\.exe)?' is not recognized as an internal or external command/i,
      /Python was not found; run without arguments to install from the Microsoft Store/i,
      /\bpython\w*\.exe\b.*(?:was not found|could not be found)/i,
    ],
  },
  {
    kind: 'file-in-use',
    patterns: [
      /\[WinError 32\]/,
      /being used by another process/i,
      /\bEBUSY\b/,
      /resource busy or locked/i,
    ],
  },
  {
    kind: 'access-denied',
    patterns: [
      /\[WinError 5\]/,
      /Access is denied/i,
      /\bEACCES\b/,
      /\bEPERM\b/,
      /\bPermissionError\b/,
      /\[Errno 13\] Permission denied/i,
      // Defender's quarantine, as Windows reports it to the process that lost
      // the file: WinError 225 is "the file contains a virus or potentially
      // unwanted software".
      /\[WinError 225\]/,
      /file contains a virus or potentially unwanted software/i,
    ],
  },
  {
    kind: 'pip-metadata',
    patterns: [
      /uninstall-no-record-file/i,
      /Cannot uninstall ['"]?[\w.-]+/i,
      /no RECORD file was found/i,
      /RECORD file not found/i,
      /uninstall-distutils-installed-package/i,
      /invalid-installed-package/i,
    ],
  },
  {
    kind: 'ssl',
    retryWarningsAreWeak: true,
    patterns: [
      /CERTIFICATE_VERIFY_FAILED/,
      /\bSSLError\b/,
      /SSLCertVerificationError/,
      /problem confirming the ssl certificate/i,
      /\[SSL: [A-Z_]+\]/,
    ],
  },
  {
    kind: 'proxy',
    retryWarningsAreWeak: true,
    patterns: [
      /\bProxyError\b/,
      /407 Proxy Authentication/i,
      /Cannot connect to proxy/i,
      /Tunnel connection failed/i,
    ],
  },
  {
    kind: 'timeout',
    retryWarningsAreWeak: true,
    patterns: [
      /\bConnectTimeoutError\b/,
      /\bReadTimeoutError\b/,
      /\bConnectTimeout\b/,
      /\bReadTimeout\b/,
      /\btimed out\b/i,
      /\bETIMEDOUT\b/,
    ],
  },
  {
    kind: 'network',
    retryWarningsAreWeak: true,
    patterns: [
      /Temporary failure in name resolution/i,
      /getaddrinfo failed/i,
      /\bgetaddrinfo\b/,
      /\bNewConnectionError\b/,
      /Failed to establish a new connection/i,
      /\bConnectionError\b/,
      /\bConnectionResetError\b/,
      /Max retries exceeded/i,
      /Connection aborted/i,
      /\bRemoteDisconnected\b/,
      /\bIncompleteRead\b/,
      /\bECONNRESET\b/,
      /\bECONNREFUSED\b/,
      /\bENOTFOUND\b/,
      /\bEAI_AGAIN\b/,
      /\bENETUNREACH\b/,
    ],
  },
  {
    kind: 'dependency-conflict',
    patterns: [
      /\bResolutionImpossible\b/,
      /conflicting dependencies/i,
      /\bResolutionTooDeep\b/,
    ],
  },
  {
    kind: 'no-matching-distribution',
    patterns: [
      /No matching distribution found/i,
      /Could not find a version that satisfies the requirement/i,
    ],
  },
];

const RETRY_WARNING = /^\s*WARNING: Retrying \(Retry\(/;

// How pip says it never got a usable answer from the index. When every
// attempt failed, the retry warnings are the only record of why.
const INDEX_UNREACHABLE = [
  /No matching distribution found/i,
  /Could not find a version that satisfies the requirement/i,
  /Could not fetch URL/i,
];

const MAX_EVIDENCE_LINES = 15;
// pip prints entire exception chains on one line; the details area should
// still show every matching line rather than one screen-wide wall.
const MAX_LINE_LENGTH = 400;
const CONTEXT_BEFORE = 1;
const CONTEXT_AFTER = 1;

/* eslint-disable no-control-regex */
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
/* eslint-enable no-control-regex */

/**
 * pip redraws its progress bar with carriage returns, and rich draws it out of
 * box characters; neither says anything about why the install failed, and a
 * large wheel can fill the whole tail of the output with them.
 */
function isProgressNoise(raw: string): boolean {
  const line = raw.trim();
  if (/[━█▏▎▍▌▋▊▉]/.test(line)) return true;
  // The ASCII bar pip falls back to: "   ---------------------------------------- 1.2/5.0 MB 3.4 MB/s eta 0:00:02"
  if (/^-{5,}\s*[\d.]+\/[\d.]+\s*[kMG]?i?B/.test(line)) return true;
  if (/\beta \d+:\d{2}(?::\d{2})?\s*$/.test(line) && /[\d.]+\s*[kMG]?i?B\/s/.test(line)) return true;
  // 7-Zip's percentage counter: "  42% 13 - some\\file.dll"
  if (/^\d{1,3}%(\s|$)/.test(line)) return true;
  return false;
}

/** Output split into the lines a person would read: last redraw only, no colour codes. */
function readableLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map(raw => {
      // A carriage return without a newline overwrites the line in place;
      // what is left on screen is the final segment.
      const segments = raw.split('\r').filter(segment => segment.trim() !== '');
      const last = segments.length > 0 ? segments[segments.length - 1] : '';
      return last.replace(ANSI, '').trimEnd();
    });
}

function clip(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > MAX_LINE_LENGTH ? `${trimmed.slice(0, MAX_LINE_LENGTH - 1)}…` : trimmed;
}

/**
 * The matching lines with a line of context either side, newest first until
 * the budget runs out. pip's final ERROR line is the conclusive one; the
 * retry warnings above it are repetitions, so the budget favours the end.
 */
function evidenceAround(lines: string[], matches: number[]): string {
  const keep = new Set<number>();
  for (let m = matches.length - 1; m >= 0; m--) {
    const window: number[] = [];
    const from = Math.max(0, matches[m] - CONTEXT_BEFORE);
    const to = Math.min(lines.length - 1, matches[m] + CONTEXT_AFTER);
    for (let i = from; i <= to; i++) {
      if (!keep.has(i) && lines[i].trim() !== '' && !isProgressNoise(lines[i])) window.push(i);
    }
    // The matched line itself is always worth its place; its context is not.
    if (keep.size + window.length > MAX_EVIDENCE_LINES) {
      if (keep.size < MAX_EVIDENCE_LINES && !keep.has(matches[m])) keep.add(matches[m]);
      continue;
    }
    window.forEach(i => keep.add(i));
  }
  return joinWithGaps(lines, [...keep].sort((a, b) => a - b));
}

/** Non-adjacent chunks are separated by "..." so nobody reads them as consecutive. */
function joinWithGaps(lines: string[], indices: number[]): string {
  const out: string[] = [];
  indices.forEach((index, n) => {
    if (n > 0 && index !== indices[n - 1] + 1) out.push('...');
    out.push(clip(lines[index]));
  });
  return out.join('\n');
}

function tailEvidence(lines: string[]): string {
  const indices: number[] = [];
  for (let i = lines.length - 1; i >= 0 && indices.length < MAX_EVIDENCE_LINES; i--) {
    if (lines[i].trim() !== '' && !isProgressNoise(lines[i])) indices.push(i);
  }
  // Dropped noise is not a gap worth marking: nothing readable was skipped.
  return indices.reverse().map(i => clip(lines[i])).join('\n');
}

function subject(step: string | undefined): string {
  const trimmed = step?.trim();
  if (!trimmed) return 'The install failed';
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)} failed`;
}

function summaryFor(kind: InstallErrorKind, step: string | undefined, exitCode: number | null | undefined): string {
  const failed = subject(step);
  switch (kind) {
    case 'disk-full':
      return `${failed} because the drive holding Vapourkit's data folder (or Windows' temporary folder, usually on C:) is full. Free up at least 10 GB and retry.`;
    case 'access-denied':
      return `${failed} because Windows denied access to a file. This is usually antivirus blocking or quarantining it, or another Vapourkit window or a running vspipe holding it; allow Vapourkit's folder in your antivirus, close those, and retry.`;
    case 'file-in-use':
      return `${failed} because a file it needed to replace is in use. Close any other Vapourkit window and running vspipe, wait for antivirus to finish scanning Vapourkit's folder, and retry.`;
    case 'path-too-long':
      return `${failed} because a file path went over Windows' 260-character limit. Move Vapourkit to a shorter folder such as C:\\Vapourkit, or enable Windows long path support, then retry.`;
    case 'network':
      return `${failed} because it could not reach the package server. Check your internet connection and any proxy, VPN or firewall, then retry.`;
    case 'timeout':
      return `${failed} because the connection to the package server timed out. Check your internet connection and any proxy or VPN, then retry.`;
    case 'ssl':
      return `${failed} because the package server's HTTPS certificate could not be verified, which usually means a corporate proxy or antivirus HTTPS scanning is intercepting the connection. Turn off HTTPS scanning for Vapourkit or try another network, then retry.`;
    case 'proxy':
      return `${failed} because a proxy server refused the connection. Check your proxy settings and login, or try without the proxy, then retry.`;
    case 'pip-missing':
      return `${failed} because Vapourkit's Python environment is missing pip, so it was damaged or only partly installed. Restart Vapourkit, which repairs pip at launch, then retry; if it happens again, open Plugins and click Reinstall.`;
    case 'pip-metadata':
      return `${failed} because an earlier install was interrupted and left a package pip cannot replace. Close any other Vapourkit window and running vspipe so it can be cleared, then retry.`;
    case 'no-matching-distribution':
      return `${failed} because a required package version is not available for this system. Check your connection and retry; if it keeps happening, report it with the log.`;
    case 'dependency-conflict':
      return `${failed} because the requested packages need incompatible versions of a shared dependency. If you installed extra Python packages yourself, remove them; otherwise report it with the log.`;
    case 'python-missing':
      return `${failed} because Vapourkit's Python could not be found; antivirus may have removed it or an earlier install did not finish. Restart Vapourkit, which runs setup again to repair it; if antivirus removed it, allow Vapourkit's folder first.`;
    case 'unknown': {
      const code = exitCode !== undefined && exitCode !== null ? ` (exit code ${exitCode})` : '';
      return `${failed}${code}. The details below and the full log show why.`;
    }
  }
}

export function classifyInstallError(
  output: string,
  context?: { step?: string; exitCode?: number | null },
): ClassifiedInstallError {
  const lines = readableLines(output ?? '');

  const indexUnreachable = lines.some(line => INDEX_UNREACHABLE.some(pattern => pattern.test(line)));

  for (const rule of RULES) {
    const matches: number[] = [];
    lines.forEach((line, index) => {
      if (rule.patterns.some(pattern => pattern.test(line))) matches.push(index);
    });
    const onlyRetries = matches.length > 0 && matches.every(index => RETRY_WARNING.test(lines[index]));
    if (rule.retryWarningsAreWeak && onlyRetries && !indexUnreachable) continue;
    if (matches.length > 0) {
      return {
        kind: rule.kind,
        summary: summaryFor(rule.kind, context?.step, context?.exitCode),
        evidence: evidenceAround(lines, matches),
      };
    }
  }

  return {
    kind: 'unknown',
    summary: summaryFor('unknown', context?.step, context?.exitCode),
    evidence: tailEvidence(lines),
  };
}

/** summary + where the full log is, for places that can only show one string */
export function formatInstallError(error: ClassifiedInstallError, logPath?: string): string {
  const where = logPath?.trim()
    ? `Full log: ${logPath.trim()}`
    : "The full log is in the logs folder inside Vapourkit's data folder.";
  return `${error.summary} ${where}`;
}
