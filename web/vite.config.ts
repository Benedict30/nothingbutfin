import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Builds the UI into ../public, which server.js serves. `npm run dev` proxies the API to it.
export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  build: { outDir: path.resolve(__dirname, '../public'), emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:3000' } },
})
