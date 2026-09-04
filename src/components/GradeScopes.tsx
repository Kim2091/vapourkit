// src/components/GradeScopes.tsx — parade, waveform, vectorscope, histogram.
//
// These read a small sample of the real frame (src/utils/gradeRenderer.ts) and
// push it through the same gradePixel() the render is defined by, so a scope
// never disagrees with the picture above it. Sampling is what makes that
// affordable: the shape of a distribution survives downsampling, and 240px of
// width is enough to see a channel clip.

import { memo, useCallback, useEffect, useRef } from 'react';
import { gradePixel, LUMA_R, LUMA_G, LUMA_B, type GradeValues } from '../utils/colorGrade';
import { GRADE_TYPE } from './gradeType';

export type ScopeKind = 'parade' | 'waveform' | 'vectorscope' | 'histogram';

export const SCOPE_LABELS: Record<ScopeKind, string> = {
  parade: 'Parade',
  waveform: 'Waveform',
  vectorscope: 'Vectorscope',
  histogram: 'Histogram',
};

const INK_950 = '#0e0f10';
const GRATICULE = 'rgba(255,255,255,0.07)';
const CHANNEL_COLORS: [string, string, string] = ['#ef5f5f', '#3ecf8e', '#6aa8f0'];

function graticule(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.strokeStyle = GRATICULE;
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const line = Math.round(y + (h * i) / 4) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, line);
    ctx.lineTo(x + w, line);
    ctx.stroke();
  }
}

/** One channel of a waveform: every sampled pixel plotted at its own column. */
function drawTrace(
  ctx: CanvasRenderingContext2D,
  sample: Float32Array,
  channel: number,
  color: string,
  x: number, y: number, w: number, h: number,
  values: GradeValues,
) {
  const sampleWidth = sample[0];
  const sampleHeight = sample[1];
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.06;
  const rowStep = Math.max(1, Math.floor(sampleHeight / 90));
  const dotWidth = Math.max(1, w / sampleWidth);
  for (let row = 0; row < sampleHeight; row += rowStep) {
    for (let column = 0; column < sampleWidth; column++) {
      const index = 2 + (row * sampleWidth + column) * 3;
      const graded = gradePixel([sample[index], sample[index + 1], sample[index + 2]], values);
      const v = channel < 0
        ? LUMA_R * graded[0] + LUMA_G * graded[1] + LUMA_B * graded[2]
        : graded[channel];
      ctx.fillRect(x + (column / sampleWidth) * w, y + (1 - v) * h - 0.5, dotWidth, 1.4);
    }
  }
  ctx.globalAlpha = 1;
}

function drawParade(ctx: CanvasRenderingContext2D, sample: Float32Array, w: number, h: number, values: GradeValues) {
  const panelWidth = (w - 8) / 3;
  for (let channel = 0; channel < 3; channel++) {
    const x = 3 + channel * (panelWidth + 1);
    graticule(ctx, x, 3, panelWidth, h - 6);
    drawTrace(ctx, sample, channel, CHANNEL_COLORS[channel], x, 3, panelWidth, h - 6, values);
  }
}

function drawWaveform(ctx: CanvasRenderingContext2D, sample: Float32Array, w: number, h: number, values: GradeValues) {
  graticule(ctx, 3, 3, w - 6, h - 6);
  drawTrace(ctx, sample, -1, '#9fe6d8', 3, 3, w - 6, h - 6, values);
}

function drawVectorscope(ctx: CanvasRenderingContext2D, sample: Float32Array, w: number, h: number, values: GradeValues) {
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) / 2 - 6;
  ctx.strokeStyle = GRATICULE;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, radius * 0.5, 0, Math.PI * 2); ctx.stroke();
  // The skin-tone line, at the I axis where flesh should land.
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(-0.55) * radius, cy - Math.sin(-0.55) * radius);
  ctx.stroke();

  const sampleWidth = sample[0];
  const sampleHeight = sample[1];
  const rowStep = Math.max(1, Math.floor(sampleHeight / 70));
  const columnStep = Math.max(1, Math.floor(sampleWidth / 120));
  ctx.fillStyle = '#e0b341';
  ctx.globalAlpha = 0.16;
  for (let row = 0; row < sampleHeight; row += rowStep) {
    for (let column = 0; column < sampleWidth; column += columnStep) {
      const index = 2 + (row * sampleWidth + column) * 3;
      const [r, g, b] = gradePixel([sample[index], sample[index + 1], sample[index + 2]], values);
      const y = LUMA_R * r + LUMA_G * g + LUMA_B * b;
      // Scaled so a fully saturated primary lands near the graticule edge.
      const u = (b - y) * 1.4;
      const v = (r - y) * 1.4;
      ctx.fillRect(cx + u * radius, cy - v * radius, 1.4, 1.4);
    }
  }
  ctx.globalAlpha = 1;
}

function drawHistogram(ctx: CanvasRenderingContext2D, sample: Float32Array, w: number, h: number, values: GradeValues) {
  graticule(ctx, 3, 3, w - 6, h - 6);
  const bins = 128;
  const counts = [new Float32Array(bins), new Float32Array(bins), new Float32Array(bins)];
  const sampleWidth = sample[0];
  const sampleHeight = sample[1];
  const rowStep = Math.max(1, Math.floor(sampleHeight / 120));
  let total = 0;
  for (let row = 0; row < sampleHeight; row += rowStep) {
    for (let column = 0; column < sampleWidth; column++) {
      const index = 2 + (row * sampleWidth + column) * 3;
      const graded = gradePixel([sample[index], sample[index + 1], sample[index + 2]], values);
      for (let channel = 0; channel < 3; channel++) {
        counts[channel][Math.min(bins - 1, Math.floor(graded[channel] * bins))]++;
      }
      total++;
    }
  }
  if (!total) return;

  let peak = 0;
  for (const channel of counts) for (const count of channel) peak = Math.max(peak, count);
  if (!peak) return;

  for (let channel = 0; channel < 3; channel++) {
    ctx.fillStyle = CHANNEL_COLORS[channel];
    ctx.globalAlpha = 0.42;
    ctx.beginPath();
    ctx.moveTo(3, h - 3);
    for (let bin = 0; bin < bins; bin++) {
      const x = 3 + (bin / (bins - 1)) * (w - 6);
      ctx.lineTo(x, h - 3 - (counts[channel][bin] / peak) * (h - 10));
    }
    ctx.lineTo(w - 3, h - 3);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

const DRAW: Record<ScopeKind, (ctx: CanvasRenderingContext2D, sample: Float32Array, w: number, h: number, v: GradeValues) => void> = {
  parade: drawParade,
  waveform: drawWaveform,
  vectorscope: drawVectorscope,
  histogram: drawHistogram,
};

interface ScopeProps {
  kind: ScopeKind;
  sample: Float32Array | null;
  values: GradeValues;
  className?: string;
  /**
   * Shortest gap between repaints, in ms. A scope grades the whole sample
   * every time it draws — measured, a parade is 7.3ms of that and all four
   * together are 13.5ms, against a 16.7ms frame — so a grid of them cannot
   * also run at frame rate. The picture is shaded on the GPU and stays at
   * full rate regardless; these are a readout, and a readout at 15Hz reads
   * the same. Left at 0 a lone scope keeps repainting every frame.
   */
  minIntervalMs?: number;
}

export const Scope = memo<ScopeProps>(({
  kind, sample, values, className = '', minIntervalMs = 0,
}: ScopeProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const paintedAtRef = useRef(0);

  // Read through refs so a drag does not tear down and rebuild the observer
  // sixty times a second just because the grade values are a new object.
  const latest = useRef({ kind, sample, values });
  latest.current = { kind, sample, values };

  const paint = useCallback(() => {
    frameRef.current = null;
    paintedAtRef.current = performance.now();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = INK_950;
    ctx.fillRect(0, 0, width, height);
    const current = latest.current;
    if (current.sample) DRAW[current.kind](ctx, current.sample, width, height, current.values);
  }, []);

  // Coalesce to one paint per frame: a trackball drag fires far faster than
  // scopes need redrawing, and each redraw grades thousands of samples. Above
  // that, minIntervalMs holds a whole grid of them to a rate they can afford.
  // The trailing timer matters as much as the gate: the last change of a drag
  // must still land, or the scope is left showing a grade you have moved on
  // from.
  const schedule = useCallback(() => {
    if (frameRef.current !== null || timerRef.current !== null) return;
    const due = minIntervalMs - (performance.now() - paintedAtRef.current);
    if (due <= 0) {
      frameRef.current = requestAnimationFrame(paint);
      return;
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      frameRef.current = requestAnimationFrame(paint);
    }, due);
  }, [paint, minIntervalMs]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(schedule);
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      frameRef.current = null;
      timerRef.current = null;
    };
  }, [schedule]);

  useEffect(schedule, [kind, sample, values, schedule]);

  return (
    <div className={`relative bg-ink-950 min-w-0 min-h-0 ${className}`}>
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full block" />
      <span
        className="absolute top-1 left-1.5 font-display font-semibold uppercase tracking-[0.11em] text-ink-500 pointer-events-none"
        style={{ fontSize: GRADE_TYPE.section }}
      >
        {SCOPE_LABELS[kind]}
      </span>
      {!sample && (
        <span className="absolute inset-0 grid place-items-center text-ink-600" style={{ fontSize: GRADE_TYPE.value }}>
          No frame
        </span>
      )}
    </div>
  );
});
