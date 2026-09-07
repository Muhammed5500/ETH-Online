import { defineConfig } from 'vitest/config';

// `pnpm test:integration` — gercek testnet gerektiren testler. Yavas.
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.integration.test.ts', 'apps/*/test/**/*.integration.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    testTimeout: 300_000,
    hookTimeout: 120_000,
    passWithNoTests: true,
  },
});
