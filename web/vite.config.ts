import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Dev: Vite (5173) proxies /api to the Fastify server. Prod: Fastify serves web/dist with SPA fallback.
const API = process.env.API_ORIGIN || 'http://localhost:3000';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/',
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: API, changeOrigin: false, ws: false },
      '/healthz': { target: API },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', sourcemap: false },
});
