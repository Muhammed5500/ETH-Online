import { createRequire } from 'node:module';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const require_ = createRequire(import.meta.url);

/**
 * Aliases for the wallet payment path.
 *
 * `@hashgraph/hedera-wallet-connect` declares `@walletconnect/*` as peers, and
 * pnpm installed only some of them into that package's own directory — so a
 * bundler resolving from inside it cannot find `sign-client` or `utils`, even
 * though this app depends on both. These aliases point the bare specifiers at
 * the copies this app already has.
 *
 * `shamefully-hoist` in `.npmrc` would also fix it, and was rejected: it
 * relaxes resolution for the entire monorepo to solve one package's packaging
 * bug, and would hide the next one.
 */
const walletAliases = {
  '@walletconnect/sign-client': require_.resolve('@walletconnect/sign-client'),
  '@walletconnect/utils': require_.resolve('@walletconnect/utils'),
  '@walletconnect/modal': require_.resolve('@walletconnect/modal'),
  buffer: require_.resolve('buffer'),
};

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
  resolve: { alias: walletAliases },
  // Vite reads `.env` from its own root, which is this package. Every other
  // piece of configuration in this repo lives in the `.env` at the top, and
  // splitting it would mean one more file to keep in step for one variable.
  envDir: '../..',
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
