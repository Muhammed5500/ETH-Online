import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Vite rather than Next.js — a deliberate deviation from the roadmap.
 *
 * Reasons, in the order they mattered:
 *
 *   One service, one origin. The build lands in `dist/` and the existing
 *   Express API serves it, so the frontend and the paid API share an origin.
 *   No CORS, no second deployment, and the x402 payment flow talks to the same
 *   host it was loaded from.
 *
 *   Nothing here needs a server. Four pages, all of them reading a REST API
 *   and polling. No SSR, no SEO, no server actions.
 *
 *   The repo has no build step anywhere else. Every package runs from
 *   TypeScript source through tsx and `build` means `tsc --noEmit`. A static
 *   bundle fits that; a second Node runtime does not.
 *
 * In dev, `/market`, `/markets`, `/agents` and `/health` are proxied to the
 * demo server so the same relative paths work in both modes.
 */
const API = process.env.VITE_API_URL ?? 'http://127.0.0.1:4021';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // Only the API's own routes. `/market/:id` as a PAGE is client-side, so
      // the proxy is scoped to what the API actually answers.
      '/api': { target: API, changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
