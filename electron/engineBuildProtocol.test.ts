import { describe, it, expect, vi } from 'vitest';
import { parseVkBuildLine, parseKnownBuildLine, createEngineBuildTracker, type EngineBuildStatus } from './engineBuildProtocol';

describe('parseVkBuildLine', () => {
  const cases: Array<[string, ReturnType<typeof parseVkBuildLine>]> = [
    ['[vk-build] begin Building TensorRT engine: rife_v4.10', { type: 'begin', label: 'Building TensorRT engine: rife_v4.10' }],
    ['[vk-build] end rife_v4.10', { type: 'end', label: 'rife_v4.10' }],
    ['[vk-build] progress 0', { type: 'progress', percent: 0 }],
    ['[vk-build] progress 42', { type: 'progress', percent: 42 }],
    ['[vk-build] progress 100', { type: 'progress', percent: 100 }],
    // Tolerant of surrounding whitespace, CR endings and foreign log prefixes
    ['   [vk-build] progress 7  \r', { type: 'progress', percent: 7 }],
    ['2026-08-11 12:00:00 INFO [vk-build] begin Denoise model', { type: 'begin', label: 'Denoise model' }],
    ['[vk-build]  begin   Spaced   label ', { type: 'begin', label: 'Spaced   label' }],
    // Out of range percentages clamp instead of being dropped
    ['[vk-build] progress 150', { type: 'progress', percent: 100 }],
    ['[vk-build] progress -5', { type: 'progress', percent: 0 }],
    // Junk
    ['', null],
    ['Building engine: 40%', null],
    ['[vk-build]', null],
    ['[vk-build] progress', null],
    ['[vk-build] progress abc', null],
    ['[vk-build] progress 12abc', null],
    ['[vk-build] restart something', null],
    ['[vk build] begin nope', null],
  ];

  for (const [line, expected] of cases) {
    it(`parses ${JSON.stringify(line)}`, () => {
      expect(parseVkBuildLine(line)).toEqual(expected);
    });
  }

  it('accepts a begin with no label', () => {
    expect(parseVkBuildLine('[vk-build] begin')).toEqual({ type: 'begin', label: '' });
  });
});

describe('parseKnownBuildLine (filters that predate the protocol)', () => {
  // Verbatim from vspipe's stderr — VapourSynth prefixes Python logging with "Warning: "
  const TFIX_BEGIN =
    'Warning: vs_temporalfix: Building new TensorRT engine for strength=2 with width=980 and height=700. This may take a few minutes.';
  const TFIX_END = 'Warning: vs_temporalfix: Engine building complete.';

  it('recognizes a vs_temporalfix build starting, naming the strength and resolution', () => {
    expect(parseKnownBuildLine(TFIX_BEGIN)).toEqual({
      type: 'begin',
      label: 'Building TensorRT engine: vs_temporalfix strength 2 (980x700)',
    });
  });

  it('recognizes a fractional strength (interpolated models)', () => {
    const line = 'Warning: vs_temporalfix: Building new TensorRT engine for strength=1.5 with width=1920 and height=1080. This may take a few minutes.';

    expect(parseKnownBuildLine(line)).toEqual({
      type: 'begin',
      label: 'Building TensorRT engine: vs_temporalfix strength 1.5 (1920x1080)',
    });
  });

  it('recognizes the build finishing', () => {
    expect(parseKnownBuildLine(TFIX_END)).toEqual({ type: 'end', label: '' });
  });

  it('ignores vs_temporalfix output that is not a build announcement', () => {
    expect(parseKnownBuildLine('Warning: vs_temporalfix: Engine loading failed. Rebuilding...')).toBeNull();
    expect(parseKnownBuildLine('vs_temporalfix: some other message')).toBeNull();
  });

  it('drives the banner end to end through the tracker', () => {
    const statuses: EngineBuildStatus[] = [];
    const tracker = createEngineBuildTracker(s => statuses.push(s));

    tracker.push(`${TFIX_BEGIN}\n`);
    tracker.push(`${TFIX_END}\n`);

    expect(statuses).toEqual([
      { status: 'building', label: 'Building TensorRT engine: vs_temporalfix strength 2 (980x700)', percent: undefined },
      { status: 'idle' },
    ]);
  });
});

describe('createEngineBuildTracker', () => {
  const track = () => {
    const statuses: EngineBuildStatus[] = [];
    const tracker = createEngineBuildTracker(s => statuses.push(s));
    return { statuses, tracker };
  };

  it('reports building on begin, carries the percent, and idles on end', () => {
    const { statuses, tracker } = track();

    tracker.push('[vk-build] begin Building TensorRT engine: dpir\n');
    tracker.push('[vk-build] progress 30\n');
    tracker.push('[vk-build] end dpir\n');

    expect(statuses).toEqual([
      { status: 'building', label: 'Building TensorRT engine: dpir', percent: undefined },
      { status: 'building', label: 'Building TensorRT engine: dpir', percent: 30 },
      { status: 'idle' },
    ]);
  });

  it('reassembles protocol lines split across stderr chunks', () => {
    const { statuses, tracker } = track();

    tracker.push('[vk-build] begi');
    tracker.push('n Engine\n[vk-build] pro');
    expect(statuses).toEqual([{ status: 'building', label: 'Engine', percent: undefined }]);

    tracker.push('gress 55\n');
    expect(statuses[1]).toEqual({ status: 'building', label: 'Engine', percent: 55 });
  });

  it('ignores non-protocol stderr noise', () => {
    const { statuses, tracker } = track();

    tracker.push('Building engine: 40%\nvspipe: some warning\n');

    expect(statuses).toEqual([]);
  });

  it('shows a build for a bare progress line with no begin', () => {
    const { statuses, tracker } = track();

    tracker.push('[vk-build] progress 12\n');

    expect(statuses).toEqual([{ status: 'building', label: 'TensorRT engine', percent: 12 }]);
  });

  it('resets the percent when a second build begins', () => {
    const { statuses, tracker } = track();

    tracker.push('[vk-build] begin A\n[vk-build] progress 80\n[vk-build] begin B\n');

    expect(statuses[statuses.length - 1]).toEqual({ status: 'building', label: 'B', percent: undefined });
  });

  it('clears an in-flight build on reset (process killed mid-build)', () => {
    const { statuses, tracker } = track();

    tracker.push('[vk-build] begin Engine\n[vk-build] progress 20\n');
    tracker.reset();

    expect(statuses[statuses.length - 1]).toEqual({ status: 'idle' });
  });

  it('emits idle on reset even when no build was running', () => {
    const onStatus = vi.fn();
    createEngineBuildTracker(onStatus).reset();

    expect(onStatus).toHaveBeenCalledWith({ status: 'idle' });
  });

  it('does not resurrect a build from buffered text after a reset', () => {
    const { statuses, tracker } = track();

    tracker.push('[vk-build] begin Engine\n[vk-build] progre');
    tracker.reset();
    tracker.push('ss 40\n');

    expect(statuses[statuses.length - 1]).toEqual({ status: 'idle' });
  });
});
