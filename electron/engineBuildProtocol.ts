// electron/engineBuildProtocol.ts
//
// Parser for the `[vk-build]` build-status protocol. Filters and build tools
// that run *inside* vspipe (vs-mlrt's runtime TensorRT engine builds, the
// bundled build_trt_engine.py, third-party filters like vs_temporalfix) can
// print these lines on stderr; the app parses them and shows a build banner
// instead of looking frozen for the several minutes an engine build takes.
//
//     [vk-build] begin <human-readable label>
//     [vk-build] progress <integer 0-100>     (optional, repeatable)
//     [vk-build] end <label>
//
// The marker may appear anywhere in the line so emitters can keep their own log
// prefixes. Pure module — no node/electron imports, so it stays trivially
// testable and safe to import from either executor.

export type EngineBuildEvent =
  | { type: 'begin'; label: string }
  | { type: 'progress'; percent: number }
  | { type: 'end'; label: string };

/** Payload sent to the renderer over the `engine-build-progress` channel. */
export interface EngineBuildStatus {
  status: 'building' | 'idle';
  label?: string;
  percent?: number;
}

const MARKER = '[vk-build]';

/** Guard against a runaway line with no newline pinning stderr in memory. */
const MAX_PENDING_LINE = 64 * 1024;

/**
 * Build announcements from filters that build engines their own way and don't
 * emit the protocol above. Recognizing their existing log lines is a stopgap so
 * users get a banner today; `[vk-build]` remains the contract, and an entry here
 * should be dropped once its filter adopts it.
 *
 * Deliberately exact vendor strings, not a general "looks like a build"
 * heuristic — a false positive puts up a banner with nothing to take it down
 * (only process exit would), which is worse than no banner at all. These carry
 * no progress, so the banner spins rather than filling a bar.
 */
interface BuildAnnouncement {
  begin: RegExp;
  end: RegExp;
  label: (match: RegExpMatchArray) => string;
}

const KNOWN_BUILD_ANNOUNCEMENTS: BuildAnnouncement[] = [
  {
    // vs_temporalfix (pifroggi) builds per-resolution engines with the TensorRT
    // Python API and logs these through Python logging, which VapourSynth
    // forwards to vspipe's stderr prefixed with "Warning: ".
    begin: /vs_temporalfix: Building new TensorRT engine for strength=(\S+) with width=(\d+) and height=(\d+)/,
    end: /vs_temporalfix: Engine building complete\./,
    label: m => `Building TensorRT engine: vs_temporalfix strength ${m[1]} (${m[2]}x${m[3]})`,
  },
];

/** Recognizes a known third-party build announcement (see the table above). */
export function parseKnownBuildLine(line: string): EngineBuildEvent | null {
  for (const announcement of KNOWN_BUILD_ANNOUNCEMENTS) {
    const started = line.match(announcement.begin);
    if (started) {
      return { type: 'begin', label: announcement.label(started) };
    }
    if (announcement.end.test(line)) {
      return { type: 'end', label: '' };
    }
  }
  return null;
}

/** The protocol first, then the known-filter fallbacks. */
export function parseBuildLine(line: string): EngineBuildEvent | null {
  return parseVkBuildLine(line) ?? parseKnownBuildLine(line);
}

/**
 * Parses a single stderr line. Returns null for anything that isn't a valid
 * protocol line (which is nearly every line vspipe emits).
 */
export function parseVkBuildLine(line: string): EngineBuildEvent | null {
  const markerIndex = line.indexOf(MARKER);
  if (markerIndex === -1) {
    return null;
  }

  const rest = line.slice(markerIndex + MARKER.length).trim();
  const separator = rest.search(/\s/);
  const verb = separator === -1 ? rest : rest.slice(0, separator);
  const argument = separator === -1 ? '' : rest.slice(separator + 1).trim();

  switch (verb) {
    case 'begin':
      return { type: 'begin', label: argument };
    case 'end':
      return { type: 'end', label: argument };
    case 'progress': {
      const token = argument.split(/\s+/)[0];
      if (!/^[+-]?\d+$/.test(token)) {
        return null;
      }
      // Clamp rather than reject: a misbehaving emitter shouldn't stall the bar
      return { type: 'progress', percent: Math.min(100, Math.max(0, parseInt(token, 10))) };
    }
    default:
      return null;
  }
}

/**
 * Turns a stderr byte stream into build-status updates. Owns the partial-line
 * buffer (stderr chunks split mid-line) and the current label/percent, so both
 * executors behave identically.
 *
 * `reset()` is the anti-stick rule: call it on every process close/error/cancel
 * path so the banner can never outlive the process that raised it.
 */
export function createEngineBuildTracker(onStatus: (status: EngineBuildStatus) => void) {
  let pending = '';
  let label: string | null = null;
  let percent: number | undefined;

  const emit = () => {
    onStatus(label === null ? { status: 'idle' } : { status: 'building', label, percent });
  };

  return {
    /** Feeds a stderr chunk; emits a status update for every protocol line in it. */
    push(chunk: string): void {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      if (pending.length > MAX_PENDING_LINE) {
        pending = '';
      }

      for (const line of lines) {
        const event = parseBuildLine(line);
        if (!event) continue;

        if (event.type === 'begin') {
          label = event.label || 'TensorRT engine';
          percent = undefined;
        } else if (event.type === 'progress') {
          // A bare progress line without a begin still means something is
          // building — show the banner rather than dropping the update
          if (label === null) {
            label = 'TensorRT engine';
          }
          percent = event.percent;
        } else {
          label = null;
          percent = undefined;
        }
        emit();
      }
    },

    /** Clears any active build; safe (and expected) to call more than once. */
    reset(): void {
      pending = '';
      label = null;
      percent = undefined;
      onStatus({ status: 'idle' });
    },
  };
}

export type EngineBuildTracker = ReturnType<typeof createEngineBuildTracker>;
