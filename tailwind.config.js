/** @type {import('tailwindcss').Config} */
export default {
    content: [
      "./index.html",
      "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
      extend: {
        colors: {
          'dark-bg': '#0a0e1a',
          'dark-surface': '#131824',
          'dark-elevated': '#1a1f2e',
          'primary-blue': '#3b82f6',
          'primary-purple': '#8b5cf6',
          'accent-cyan': '#06b6d4',
        }
      },
    },
    plugins: [],
  }