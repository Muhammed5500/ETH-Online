import { defineConfig } from 'vitest/config';

// `pnpm test` — birim testleri. AGA CIKMAZ.
// Ag gerektiren her sey *.integration.test.ts uzantisiyla ayrilir ve
// vitest.integration.config.ts ile ayri komutta kosar. Sebep: tam suite
// her adimda calisacak, saniyeler icinde bitmeli.
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
});
