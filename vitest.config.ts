import { defineConfig } from 'vitest/config';

// Default (green) gate — the single Vitest config. The short-lived phase-1
// `*.test.red.ts` investigation suite and its `vitest.config.red.ts` were
// folded into the normal suite when the #387 host-seam fix landed (parent #390
// phase 2), so there is no separate red config or `npm run test:red` anymore.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.{test,spec}.?(c|m)[jt]s?(x)'],
  },
});
