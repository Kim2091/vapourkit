/** @type {import('tailwindcss').Config} */

// Colour system — see docs/design/README.md
//
// Two families and nothing else:
//
//   ink-*     a single neutral ramp, hsl(220 5% L). Cool enough to read as
//             "screen", desaturated enough to read as grey. Every surface,
//             border and text colour comes from here.
//   accent-*  the one decorative hue (teal). Means active / selected /
//             primary action. Nothing else.
//
// ok / warn / bad carry meaning and never change with the accent — that
// separation is what keeps the accent free to be decorative.
//
// Tailwind's default `gray` is overridden with the same neutral ramp so the
// ~400 existing gray-* classes desaturate along with everything else.

// hsl(220 5% L) at every stop. 850 and 750 are extra stops Tailwind's default
// gray doesn't have — a dark UI needs the most resolution at the dark end.
const ink = {
  950: '#0e0f10', // L6   app background
  900: '#171819', // L9.5 panel
  850: '#1f2123', // L13  raised / hover
  800: '#292b2e', // L17  input fill, subtle border
  750: '#333538', // L21  border
  700: '#3f4146', // L26  strong border
  600: '#52555b', // L34  disabled
  500: '#878a92', // L55  dim text — 5.2:1 on 900, 4.7:1 on 850. L45 was 3.6:1.
  400: '#a1a4aa', // L65  muted text
  300: '#d4d6d8', // L84
  200: '#e7e8e9', // L91  primary text
  100: '#f4f5f5', // L96
  50:  '#fafafa', // L98
};

const accent = {
  200: '#bbe7e1',
  300: '#95dad0',
  400: '#67cbbc',
  500: '#3fb9a6', // DEFAULT
  600: '#319b8b',
  700: '#267e70',
  800: '#1c5f55',
  900: '#123f39',
  DEFAULT: '#3fb9a6',
  ink: '#04120f', // text that sits on a solid accent fill
};

export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      // Tailwind's own defaults for these are blue-500 and white — the last
      // place the old palette survived. Any bare `ring-*` would flash blue
      // against a dark UI.
      ringColor: { DEFAULT: accent[500] },
      ringOffsetColor: { DEFAULT: ink[950] },

      fontFamily: {
        // Bahnschrift is the DIN-derived grotesque that ships with Windows 10
        // and 11 — condensed, engineered, and already on every machine that
        // runs Vapourkit. Used uppercase with tracking for the wordmark and
        // section headers; body text stays on the system UI stack.
        display: ['Bahnschrift', 'DIN Alternate', 'Segoe UI Variable Display', 'Segoe UI Semibold', 'system-ui', 'sans-serif'],
        mono: ['Cascadia Mono', 'Cascadia Code', 'Consolas', 'ui-monospace', 'monospace'],
      },
      colors: {
        ink,
        accent,
        gray: ink,

        // Full ramps, not just the three stops in use — a `bad-300` that
        // doesn't exist renders as no colour at all rather than failing loudly,
        // so the scales cover every stop the codebase might reach for.
        ok: {
          DEFAULT: '#3ecf8e',
          200: '#a8ecce', 300: '#7fe2b6', 400: '#5cdba3', 500: '#3ecf8e',
          600: '#2fae76', 700: '#248c5e', 800: '#1a6446', 900: '#123a2a',
        },
        warn: {
          DEFAULT: '#e0b341',
          200: '#f4e0ac', 300: '#efd28a', 400: '#e9c463', 500: '#e0b341',
          600: '#c2952c', 700: '#9a7420', 800: '#6d5217', 900: '#3d2f0f',
        },
        bad: {
          DEFAULT: '#ef5f5f',
          200: '#fac2c2', 300: '#f7a3a3', 400: '#f47d7d', 500: '#ef5f5f',
          600: '#d94848', 700: '#b23636', 800: '#7d2727', 900: '#3f1717',
        },
      },
    },
  },
  plugins: [],
}
