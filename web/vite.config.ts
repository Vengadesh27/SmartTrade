import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const BACKEND = 'http://127.0.0.1:8787';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/auth': { target: BACKEND, changeOrigin: true },
      '/candles': { target: BACKEND, changeOrigin: true },
      '/quote': { target: BACKEND, changeOrigin: true },
      '/health': { target: BACKEND, changeOrigin: true },
      '/settings': { target: BACKEND, changeOrigin: true },
      '/chat': { target: BACKEND, changeOrigin: true },
      '/chain': { target: BACKEND, changeOrigin: true },
      '/positions': { target: BACKEND, changeOrigin: true },
      '/funds': { target: BACKEND, changeOrigin: true },
      '/bot': { target: BACKEND, changeOrigin: true },
      '/feed': { target: BACKEND, changeOrigin: true },
      '/ws': { target: BACKEND.replace('http', 'ws'), changeOrigin: true, ws: true },
    },
  },
})
