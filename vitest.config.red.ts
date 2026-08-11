import { defineConfig } from 'vitest/config';

// Phase-1 #387 red-fixture / investigation suite (`lib/harnessChat.test.red.ts`).
//
// Isolated in its OWN config so the default config (`vitest.config.ts`) never
// discovers red files — a bare `npx vitest run`, IDE "run all", or any CI job
// that omits the red suite stays green during #387 triage.
//
// Run explicitly (gets the one genuinely-red fixture to show RED):
//   npm run test:red
//
// When phase 2 (parent #390) fixes the failing invariant, delete this config,
// fold `lib/harnessChat.test.red.ts` into a normal `*.test.ts`, and the default
// gate (`vitest run` → `vitest.config.ts`) will run it.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.red.ts'],
  },
});
