import { createHash } from 'node:crypto';

/**
 * POSITIVE-CONTROL fixture (backend-agents B11, plan #805).
 *
 * The static-graph regression (`staticGraph.test.ts`) asserts this workflow
 * entry's closure **reaches a banned module** → the checker must FAIL it. It
 * imports `node:crypto` — a genuinely-reachable Workflow-bundle leak (crypto
 * belongs server-side in tenancy/sandbox, never in the canvas), and one of the
 * `node:crypto`-reach cases the plan's testing matrix names.
 *
 * PLAN DELTA (grounded, 2026-08-24): the plan's "live baseline" claimed `pg`
 * is a direct dependency and the positive control imports `pg`; **`pg` is not
 * a dependency of this repo** (verified: `package.json` dependencies ship
 * `postgres`, not `pg`; no `node_modules/pg`). `import pg from 'pg'` would not
 * typecheck. The positive control therefore uses `node:crypto` (banned,
 * builtin, always typechecks) as the real leak carrier; bare-`pg` mapping is
 * still covered at the resolver unit level (`resolveImport('pg') → 'pg'`) in
 * the regression. The locked mechanism (explicit-root closure walk + ban set)
 * is unchanged.
 *
 * ADVERSARIAL L4 fix (2026-08-24): this fixture deliberately carries **no
 * `'use workflow'` directive**. `withWorkflow()` (next.config.js) discovers and
 * bundles workflow entries *by that directive*, so marking the fixture here would
 * ship `node:crypto` in the real Workflows bundle — the exact leak this lock
 * exists to prevent. The walker reads source only and needs no directive, so a
 * plain `.ts` `'use workflow'`-free file is still a valid positive control.
 *
 * Never dispatched — the regression reads it as source only.
 */
export async function dangerousGraphFixture(): Promise<{ status: 'leaky' }> {
  // No 'use workflow' directive (adversarial L4 fix): withWorkflow() bundles
  // directive-marked entries, which would ship node:crypto in the Workflows
  // bundle. The walker reads source, so the closure still sees `node:crypto`.
  void createHash('sha256').update('leak').digest('hex');
  return { status: 'leaky' };
}
