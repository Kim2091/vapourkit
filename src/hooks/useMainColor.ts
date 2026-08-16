import { useCallback, useEffect, useState } from 'react';

export const DEFAULT_MAIN_COLOR = '#1f2123';

const MAIN_COLOR_STORAGE_KEY = 'vk-main-color';

const DEFAULT_MAIN_PALETTE = {
  950: '#0e0f10',
  900: '#171819',
  850: '#1f2123',
  800: '#292b2e',
  750: '#333538',
  700: '#3f4146',
  600: '#52555b',
  500: '#878a92',
  400: '#a1a4aa',
  300: '#d4d6d8',
  200: '#e7e8e9',
  100: '#f4f5f5',
  50: '#fafafa',
} as const;

const INK_STOPS = [950, 900, 850, 800, 750, 700, 600, 500, 400, 300, 200, 100, 50] as const;

type Rgb = { r: number; g: number; b: number };
type Hsl = { h: number; s: number; l: number };

function normalizeHex(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(normalized)) return normalized;
  if (/^#[0-9a-f]{3}$/.test(normalized)) {
    return `#${normalized.slice(1).split('').map((digit) => `${digit}${digit}`).join('')}`;
  }
  return null;
}

function hexToRgb(hex: string): Rgb {
  const value = hex.slice(1);
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;

  if (max === min) return { h: 0, s: 0, l: lightness };

  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue: number;

  switch (max) {
    case red:
      hue = (green - blue) / delta + (green < blue ? 6 : 0);
      break;
    case green:
      hue = (blue - red) / delta + 2;
      break;
    default:
      hue = (red - green) / delta + 4;
      break;
  }

  return { h: hue / 6, s: saturation, l: lightness };
}

function hueToRgb(p: number, q: number, t: number): number {
  let adjusted = t;
  if (adjusted < 0) adjusted += 1;
  if (adjusted > 1) adjusted -= 1;
  if (adjusted < 1 / 6) return p + (q - p) * 6 * adjusted;
  if (adjusted < 1 / 2) return q;
  if (adjusted < 2 / 3) return p + (q - p) * (2 / 3 - adjusted) * 6;
  return p;
}

function hslToRgb({ h, s, l }: Hsl): Rgb {
  if (s === 0) {
    const channel = Math.round(l * 255);
    return { r: channel, g: channel, b: channel };
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hueToRgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hueToRgb(p, q, h) * 255),
    b: Math.round(hueToRgb(p, q, h - 1 / 3) * 255),
  };
}

function rgbToHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function toRgbChannels(rgb: Rgb): string {
  return `${rgb.r} ${rgb.g} ${rgb.b}`;
}

/**
 * Produces the complete dark interface palette from a selected hue. The
 * lightness of each stop remains fixed, so even a bright selection cannot
 * turn the application into a light theme or reduce text contrast.
 */
export function getMainColorVariables(value: string): Record<string, string> {
  const hex = normalizeHex(value) ?? DEFAULT_MAIN_COLOR;
  const palette = hex === DEFAULT_MAIN_COLOR
    ? DEFAULT_MAIN_PALETTE
    : (() => {
        const baseHsl = rgbToHsl(hexToRgb(hex));
        const lightnessByStop: Record<number, number> = {
          950: 0.06,
          900: 0.095,
          850: 0.13,
          800: 0.17,
          750: 0.21,
          700: 0.26,
          600: 0.34,
          500: 0.55,
          400: 0.65,
          300: 0.84,
          200: 0.91,
          100: 0.96,
          50: 0.98,
        };

        return Object.fromEntries(
          INK_STOPS.map((stop) => {
            const isSurface = stop >= 600;
            const saturation = isSurface ? baseHsl.s : Math.min(baseHsl.s * 0.35, 0.12);
            return [stop, rgbToHex(hslToRgb({ h: baseHsl.h, s: saturation, l: lightnessByStop[stop] }))];
          }),
        ) as Record<(typeof INK_STOPS)[number], string>;
      })();

  return Object.fromEntries(
    INK_STOPS.map((stop) => [`--ink-${stop}`, toRgbChannels(hexToRgb(palette[stop]))]),
  );
}

function readStoredMainColor(): string {
  if (typeof localStorage === 'undefined') return DEFAULT_MAIN_COLOR;
  return normalizeHex(localStorage.getItem(MAIN_COLOR_STORAGE_KEY) ?? '') ?? DEFAULT_MAIN_COLOR;
}

export function useMainColor() {
  const [mainColor, setMainColorState] = useState(readStoredMainColor);

  useEffect(() => {
    const root = document.documentElement;
    const variables = getMainColorVariables(mainColor);
    for (const [name, value] of Object.entries(variables)) {
      root.style.setProperty(name, value);
    }
  }, [mainColor]);

  const setMainColor = useCallback((value: string) => {
    const normalized = normalizeHex(value);
    if (!normalized) return;
    setMainColorState(normalized);
    localStorage.setItem(MAIN_COLOR_STORAGE_KEY, normalized);
  }, []);

  const resetMainColor = useCallback(() => {
    setMainColor(DEFAULT_MAIN_COLOR);
  }, [setMainColor]);

  return { mainColor, setMainColor, resetMainColor };
}
