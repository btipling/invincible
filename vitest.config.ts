import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Explicit discovery so `npm run test:red` can select the phase-1 #387
    // red-fixture suite (`*.test.red.ts`) by path. Default `npm test` excludes
    // those files via `vitest run --exclude '**/*.test.red.ts'` (see
    // package.json) so the ordinary gate stays green during triage.
    include: [
      '**/*.{test,spec}.?(c|m)[jt]s?(x)',
      '**/*.test.red.ts',
    ],
  },
});
