import { useCallback, useEffect, useState } from 'react';

export const DEFAULT_ACCENT_COLOR = '#3fb9a6';

const ACCENT_COLOR_STORAGE_KEY = 'vk-accent-color';

const DEFAULT_ACCENT_PALETTE = {
  200: '#bbe7e1',
  300: '#95dad0',
  400: '#67cbbc',
  500: '#3fb9a6',
  600: '#319b8b',
  700: '#267e70',
  800: '#1c5f55',
  900: '#123f39',
  ink: '#04120f',
} as const;

type Rgb = { r: number; g: number; b: number };
type Hsl = { h: number; s: number; l: number };

const ACCENT_STOPS = [200, 300, 400, 500, 600, 700, 800, 900] as const;

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

function toRgbChannels(rgb: Rgb): string {
  return `${rgb.r} ${rgb.g} ${rgb.b}`;
}

function rgbToHex(rgb: Rgb): string {
  return `#${[rgb.r, rgb.g, rgb.b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function relativeLuminance({ r, g, b }: Rgb): number {
  const channels = [r, g, b].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(first: Rgb, second: Rgb): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

export function getAccentColorVariables(value: string): Record<string, string> {
  const hex = normalizeHex(value) ?? DEFAULT_ACCENT_COLOR;
  const baseRgb = hexToRgb(hex);
  const palette = hex === DEFAULT_ACCENT_COLOR
    ? DEFAULT_ACCENT_PALETTE
    : (() => {
        const baseHsl = rgbToHsl(baseRgb);
        const lightnessByStop: Record<number, number> = {
          200: 0.86,
          300: 0.74,
          400: 0.62,
          500: baseHsl.l,
          600: Math.max(0.28, baseHsl.l * 0.82),
          700: Math.max(0.20, baseHsl.l * 0.64),
          800: Math.max(0.14, baseHsl.l * 0.48),
          900: Math.max(0.09, baseHsl.l * 0.32),
        };
        return {
          ...Object.fromEntries(
            ACCENT_STOPS.map((stop) => [
              stop,
              stop === 500 ? hex : rgbToHex(hslToRgb({ ...baseHsl, l: lightnessByStop[stop] })),
            ]),
          ),
          ink: contrastRatio(baseRgb, hexToRgb('#04120f')) >= contrastRatio(baseRgb, hexToRgb('#ffffff'))
            ? '#04120f'
            : '#ffffff',
        } as Record<number | 'ink', string>;
      })();

  const variables: Record<string, string> = {
    '--accent': hex,
    '--accent-rgb': `${baseRgb.r}, ${baseRgb.g}, ${baseRgb.b}`,
  };

  for (const stop of ACCENT_STOPS) {
    variables[`--accent-${stop}`] = toRgbChannels(hexToRgb(palette[stop]));
  }
  variables['--accent-ink'] = toRgbChannels(hexToRgb(palette.ink));
  return variables;
}

function readStoredAccentColor(): string {
  if (typeof localStorage === 'undefined') return DEFAULT_ACCENT_COLOR;
  return normalizeHex(localStorage.getItem(ACCENT_COLOR_STORAGE_KEY) ?? '') ?? DEFAULT_ACCENT_COLOR;
}

export function useAccentColor() {
  const [accentColor, setAccentColorState] = useState(readStoredAccentColor);

  useEffect(() => {
    const root = document.documentElement;
    const variables = getAccentColorVariables(accentColor);
    for (const [name, value] of Object.entries(variables)) {
      root.style.setProperty(name, value);
    }
  }, [accentColor]);

  const setAccentColor = useCallback((value: string) => {
    const normalized = normalizeHex(value);
    if (!normalized) return;
    setAccentColorState(normalized);
    localStorage.setItem(ACCENT_COLOR_STORAGE_KEY, normalized);
  }, []);

  const resetAccentColor = useCallback(() => {
    setAccentColor(DEFAULT_ACCENT_COLOR);
  }, [setAccentColor]);

  return { accentColor, setAccentColor, resetAccentColor };
}
