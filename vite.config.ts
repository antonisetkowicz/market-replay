import { defineConfig } from 'vite'
import path from 'node:path'
import { localDataPlugin } from './scripts/localData.mjs'

// Local deep-history CSVs (scripts/download-dukascopy.mjs) live outside the app dir; override with MR_DATA_DIR.
const dataDir = process.env.MR_DATA_DIR ?? path.resolve(import.meta.dirname, '../data')

// Yahoo has no CORS headers; the dev server proxies /yahoo to it (local, personal use only).
export default defineConfig({
  base: './',
  plugins: [localDataPlugin(dataDir)],
  server: {
    proxy: {
      '/yahoo': {
        target: 'https://query1.finance.yahoo.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/yahoo/, ''),
        headers: { 'User-Agent': 'Mozilla/5.0' },
      },
    },
  },
  test: { environment: 'node' },
})
