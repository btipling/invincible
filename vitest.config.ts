import { defineConfig } from 'vitest/config';

// Default (green) gate. The phase-1 #387 red-fixture suite (`*.test.red.ts`)
// is deliberately NOT discovered here: vitest's default include glob
// (`**/*.{test,spec}.?(c|m)[jt]s?(x)`) never matches `*.test.red.ts`, so a bare
// `npx vitest run`, an IDE "run all", or any future CI job that forgets to
// exclude the red suite stays green during triage.
//
// Run the red suite explicitly with `npm run test:red`, which switches to the
// dedicated `vitest.config.red.ts` config (no `--exclude` footgun needed in the
// default gate).
export default defineConfig({
  test: {
    environment: 'node',
    // Explicit default include so it is obvious `.test.red.ts` is OUTSIDE this
    // gate (and matches vitest's own default glob) — not discovered here.
    include: ['**/*.{test,spec}.?(c|m)[jt]s?(x)'],
  },
});
