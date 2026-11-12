import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * In production the API serves this build from its own origin (no CORS). In development the
 * Vite server proxies the API routes, keeping the browser's Origin header (the API checks it):
 * run the API with API_ORIGIN=http://localhost:5173.
 */
const api = process.env.CORTEX_API ?? 'http://127.0.0.1:8080';
// Exact API prefixes only: '/system' and '/bot/…' are dashboard pages.
const proxied = ['/auth', '/bots', '/audit', '/system/info', '/healthz', '/readyz'];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      ...Object.fromEntries(proxied.map((p) => [p, { target: api }])),
      '/ws': { target: api.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
    chunkSizeWarningLimit: 600,
    // Never inline assets as data: URIs: the API's CSP allows fonts and images only from 'self'.
    assetsInlineLimit: 0,
  },
});
