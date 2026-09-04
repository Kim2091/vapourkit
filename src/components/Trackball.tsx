// src/components/Trackball.tsx — one Resolve-style ball with its master bar.
//
// Drag anywhere inside the disc: the offset from centre is the colour push, so
// the ring is a boundary, not a hue picker, and clicking it never snaps the
// puck somewhere you did not ask for. Double-click the disc resets the ball,
// double-click the bar resets only the master. The four numbers underneath are
// R, G, B and master, and each scrubs — that is where "split by R, G and B"
// actually lives, and it is what you read back in the saved .vkfilter. They
// wrap to two rows rather than four columns, because five monospace digits
// four times over has never fitted across a ball this size.

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ballToPuck, puckToBall, BALL_NEUTRAL, type BallName, type BallValues } from '../utils/colorGrade';

interface TrackballProps {
  name: BallName;
  label: string;
  hint: string;
  value: BallValues;
  /** Disc diameter in px; the dock shrinks these on short windows. */
  size: number;
  disabled?: boolean;
  /** Fires continuously while dragging. */
  onChange: (value: BallValues) => void;
  /** Fires once when a gesture ends, so history records one entry per drag. */
  onCommit: () => void;
}

const MASTER_RANGE: Record<BallName, { min: number; max: number }> = {
  lift: { min: -0.5, max: 0.5 },
  offset: { min: -0.5, max: 0.5 },
  gamma: { min: 0.25, max: 4 },
  gain: { min: 0, max: 4 },
};

const CHANNELS = ['r', 'g', 'b', 'm'] as const;

/** A readout cell holds five monospace characters — "1.000", "-.120", "+.020"
    — which at 9px is about 27px, so 29 is one that never collides with its
    neighbour. Four of them across an 84px ball is 21px each, which is what
    made the numbers overlap into a smear at every size; the row wraps instead
    of overflowing, and the column widens if even two will not fit. */
const READOUT_CELL = 29;
const READOUT_GAP = 2;

/** How many readout cells fit across a ball of this size. */
export function readoutColumns(size: number): number {
  return size >= READOUT_CELL * 4 + READOUT_GAP * 3 ? 4 : 2;
}

/** A trackball column is as wide as its ball, or its numbers, whichever needs
    more. The dock's width solver has to agree with this or the primaries
    block silently overflows. */
export function trackballColumnWidth(size: number): number {
  const columns = readoutColumns(size);
  return Math.max(size, columns * READOUT_CELL + (columns - 1) * READOUT_GAP);
}

const CHANNEL_TINT: Record<(typeof CHANNELS)[number], string> = {
  r: 'text-bad-400',
  g: 'text-ok-400',
  b: 'text-[#6aa8f0]',
  m: 'text-accent-300',
};

/** Fine drag holds a tenth of the travel per pixel. */
const fineFactor = (event: { shiftKey: boolean }) => (event.shiftKey ? 0.1 : 1);

export const Trackball = memo<TrackballProps>(({
  name, label, hint, value, size, disabled = false, onChange, onCommit,
}: TrackballProps) => {
  const discRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<{ kind: 'disc' | 'master' | 'channel'; channel?: number; startX: number; startY: number; origin: BallValues } | null>(null);
  const [dragging, setDragging] = useState(false);

  const neutral = BALL_NEUTRAL[name];
  const puck = ballToPuck(name, value);
  const range = MASTER_RANGE[name];
  const masterFraction = (value.m - range.min) / (range.max - range.min);

  const emit = useCallback((next: BallValues) => onChange(next), [onChange]);

  // The gesture is tracked on window so the pointer may leave the disc mid-drag.
  useEffect(() => {
    const gesture = gestureRef.current;
    if (!dragging || !gesture) return;

    const onMove = (event: MouseEvent) => {
      const scale = fineFactor(event);
      if (gesture.kind === 'disc') {
        const element = discRef.current;
        if (!element) return;
        const rect = element.getBoundingClientRect();
        const radius = rect.width / 2;
        let x = (event.clientX - rect.left - radius) / radius;
        let y = -(event.clientY - rect.top - radius) / radius;
        if (scale !== 1) {
          const start = ballToPuck(name, gesture.origin);
          x = start.x + (x - start.x) * scale;
          y = start.y + (y - start.y) * scale;
        }
        const length = Math.hypot(x, y);
        if (length > 1) { x /= length; y /= length; }
        emit(puckToBall(name, x, y, gesture.origin.m));
        return;
      }

      const span = range.max - range.min;
      if (gesture.kind === 'master') {
        const delta = ((event.clientX - gesture.startX) / 160) * span * scale;
        const next = Math.min(range.max, Math.max(range.min, gesture.origin.m + delta));
        emit({ ...gesture.origin, m: next });
        return;
      }

      const channel = CHANNELS[gesture.channel ?? 0];
      const delta = ((event.clientX - gesture.startX) / 160) * span * scale;
      const next = Math.min(range.max, Math.max(range.min, gesture.origin[channel] + delta));
      emit({ ...gesture.origin, [channel]: next });
    };

    const onUp = () => {
      gestureRef.current = null;
      setDragging(false);
      onCommit();
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, emit, name, onCommit, range.max, range.min]);

  const begin = (kind: 'disc' | 'master' | 'channel', event: React.MouseEvent, channel?: number) => {
    if (disabled) return;
    event.preventDefault();
    gestureRef.current = { kind, channel, startX: event.clientX, startY: event.clientY, origin: value };
    setDragging(true);
    if (kind === 'disc') {
      const rect = event.currentTarget.getBoundingClientRect();
      const radius = rect.width / 2;
      let x = (event.clientX - rect.left - radius) / radius;
      let y = -(event.clientY - rect.top - radius) / radius;
      const length = Math.hypot(x, y);
      if (length > 1) { x /= length; y /= length; }
      emit(puckToBall(name, x, y, value.m));
    }
  };

  const resetBall = () => {
    if (disabled) return;
    emit({ ...neutral, m: value.m });
    onCommit();
  };
  const resetMaster = () => {
    if (disabled) return;
    emit({ ...value, m: neutral.m });
    onCommit();
  };
  const resetAll = () => {
    if (disabled) return;
    emit(neutral);
    onCommit();
  };

  // Keyboard nudges the puck; the disc is a real control, not a mouse toy.
  const onDiscKeyDown = (event: React.KeyboardEvent) => {
    if (disabled) return;
    const step = event.shiftKey ? 0.01 : 0.05;
    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step],
    };
    if (event.key === 'Escape' || event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      resetAll();
      return;
    }
    const delta = deltas[event.key];
    if (!delta) return;
    event.preventDefault();
    let x = puck.x + delta[0];
    let y = puck.y + delta[1];
    const length = Math.hypot(x, y);
    if (length > 1) { x /= length; y /= length; }
    emit(puckToBall(name, x, y, value.m));
    onCommit();
  };

  const format = (channel: (typeof CHANNELS)[number]) => {
    const v = value[channel];
    if (name === 'lift' || name === 'offset') {
      const text = v.toFixed(3);
      return v > 0 ? `+${text.replace(/^0/, '')}` : text.replace(/^(-?)0/, '$1');
    }
    return v.toFixed(3);
  };

  const radius = size / 2;
  const columns = readoutColumns(size);

  return (
    <div
      className="flex flex-col items-center gap-1.5 flex-shrink-0"
      style={{ width: trackballColumnWidth(size) }}
    >
      <div
        ref={discRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={`${label} colour balance`}
        aria-valuetext={`red ${format('r')}, green ${format('g')}, blue ${format('b')}`}
        aria-disabled={disabled}
        onMouseDown={(event) => begin('disc', event)}
        onDoubleClick={resetBall}
        onKeyDown={onDiscKeyDown}
        title={`${label} — drag to push colour, double-click to reset`}
        className={`relative rounded-full border border-ink-700 select-none touch-none
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500
          ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-crosshair'}`}
        style={{
          width: size,
          height: size,
          background:
            'conic-gradient(#ef5f5f,#e0b341,#3ecf8e,#3fb9a6,#6aa8f0,#b07de0,#ef5f5f)',
          filter: 'saturate(0.72) brightness(0.78)',
        }}
      >
        {/* Desaturated centre: the ring reads as direction, not as a palette. */}
        <span
          aria-hidden="true"
          className="absolute inset-0 rounded-full pointer-events-none"
          style={{ background: 'radial-gradient(circle, rgba(20,22,24,0.96) 12%, rgba(20,22,24,0) 72%)' }}
        />
        <span
          aria-hidden="true"
          className="absolute rounded-full bg-white border border-ink-950 pointer-events-none shadow"
          style={{
            width: 11,
            height: 11,
            left: radius + puck.x * radius - 5.5,
            top: radius - puck.y * radius - 5.5,
          }}
        />
      </div>

      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={`${label} master`}
        aria-valuenow={Number(value.m.toFixed(3))}
        aria-valuemin={range.min}
        aria-valuemax={range.max}
        onMouseDown={(event) => begin('master', event)}
        onDoubleClick={resetMaster}
        title={`${label} master — drag to change, double-click to reset`}
        style={{ width: size }}
        className={`h-[3px] rounded-sm bg-ink-800 relative
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-900
          ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-ew-resize'}`}
      >
        <span aria-hidden="true" className="absolute left-1/2 -top-0.5 w-px h-[7px] bg-ink-700" />
        <span
          aria-hidden="true"
          className="absolute -top-[3px] w-[9px] h-[9px] rounded-full bg-ink-400 border border-ink-950"
          style={{ left: `calc(${Math.min(1, Math.max(0, masterFraction)) * 100}% - 4.5px)` }}
        />
      </div>

      <span className="font-display text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-400 leading-none">
        {label}
      </span>
      <span className="text-[9px] text-ink-600 leading-none -mt-1">{hint}</span>

      <div
        className="grid w-full"
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gap: READOUT_GAP,
        }}
      >
        {CHANNELS.map((channel, index) => (
          <button
            key={channel}
            type="button"
            disabled={disabled}
            onMouseDown={(event) => begin('channel', event, index)}
            onDoubleClick={() => {
              emit({ ...value, [channel]: neutral[channel] });
              onCommit();
            }}
            title={`${label} ${channel.toUpperCase()} — drag to change, double-click to reset`}
            className={`font-mono text-[9px] tabular-nums leading-none py-[1px] rounded-sm cursor-ew-resize
              hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-50
              focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-500 ${CHANNEL_TINT[channel]}`}
          >
            {format(channel)}
          </button>
        ))}
      </div>
    </div>
  );
});
