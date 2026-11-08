import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const packageJson = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))

export default defineConfig({
  plugins: [react()],
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version)
  },
  build: {
    outDir: 'dist/renderer',
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'lucide-react'],
          codemirror: ['@uiw/react-codemirror', '@codemirror/lang-python', '@codemirror/theme-one-dark']
        }
      }
    }
  },
  server: {
    port: 5173,
    // dev:electron loads this exact port, so a busy one must fail rather than move.
    strictPort: true,
    watch: {
      ignored: ['**/data/**', '**/data2/**', '**/release/**']
    }
  }
})