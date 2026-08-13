import { defineConfig } from 'vitest/config';

// Default (green) gate — the single Vitest config. The short-lived phase-1
// `*.test.red.ts` investigation suite and its `vitest.config.red.ts` were
// folded into the normal suite when the #387 host-seam fix landed (parent #390
// phase 2), so there is no separate red config or `npm run test:red` anymore.
//
// `test.projects` (phase 3 — parent #438): the `lib/tenancy/**` suite runs in
// its own project with `forks.singleFork` + `isolate:false` so the shared
// engine singleton in `lib/tenancy/test/shared.ts` (one WASM Postgres boot)
// is truly shared **across** tenancy test files. Without it Vitest isolates
// each file and the singleton is fresh per file, silently dropping the payoff.
// Scoped to `lib/tenancy/**` so the rest of the suite keeps default
// parallelism + per-file isolation.
export default defineConfig({
  test: {
    environment: 'node',
    projects: [
      {
        test: {
          name: 'default',
          include: ['**/*.{test,spec}.?(c|m)[jt]s?(x)'],
          // Restore Vitest's default excludes (notably `**/node_modules/**`)
          // in addition to excluding the tenancy project's files. A project's
          // `exclude` replaces the defaults rather than merging with them, and
          // the phase-1 repo-wide migration ships test files inside
          // node_modules (next/zod/@vercel/oidc) that must not be collected.
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            '**/cypress/**',
            '**/.{idea,git,cache,output,temp}/**',
            '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*',
            'lib/tenancy/**',
            // Runs in the tenancy project so they share the one WASM boot.
            'scripts/backfill-sessions.test.ts',
          ],
        },
      },
      {
        test: {
          name: 'tenancy',
          environment: 'node',
          include: [
            'lib/tenancy/**/*.{test,spec}.?(c|m)[jt]s?(x)',
            // backfill-sessions boots the same schema/engine, so it shares the
            // tenancy project's single WASM boot (one boot, not two).
            'scripts/backfill-sessions.test.ts',
          ],
          pool: 'forks',
          poolOptions: {
            forks: { singleFork: true },
          },
          isolate: false,
        },
      },
    ],
  },
});
