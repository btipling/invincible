/**
 * Operator CLI (parent #411 phase 4): backfill legacy Postgres `harness_sessions`
 * (one row per user) into the Redis multi-session store, then leave Postgres as a
 * read-only durable archive.
 *
 * Primary operator path: GitHub Actions workflow `sessions-redis-backfill`
 * (`workflow_dispatch`, `confirm=backfill`, `dry_run`). Cloud agents may run the
 * same entrypoint; personal-laptop npm is never the Production cutover path.
 *
 * Wiring is **through the composition root** (mandatory DI gate — `npm test` runs
 * `scripts/di-gate.mjs` first):
 *   - Postgres: `createScriptConnection()` (`lib/di/index.ts` script-safe slice);
 *   - tenant derivation: `loadSoleMembership(uid, { db })` (read, no extra connect);
 *   - Redis: `createProdServices()` registers the root store factory, then
 *     `resolveSessionStore()` (`lib/tenancy/harnessSessionsRedis.ts`).
 *   This module body never calls `createDbConnection(`, `new PGlite(`,
 *   `createClient(` or `new RedisSessionStore(`.
 *
 * New records mint a fresh server UUID `id` (never reuse the opaque client
 * `sess_…`), seed `updatedAt: 0` with `createdAt` = migration time, and keep the
 * legacy snapshot id in `meta.legacySnapshotId`. Idempotency is a per-`{tenant,user}`
 * marker key in the separate `harness:sessions-backfill:` namespace — never "has any
 * session" (users may legitimately have many/new sessions).
 *
 * Env: DATABASE_URL, REDIS_URL (single RESP wire URL). `--dry-run` prints counts and
 * mutates nothing. Never prints REDIS_URL / credentials.
 */
import { pathToFileURL } from 'node:url';
import { createProdServices, createScriptConnection } from '../lib/di';
import { harnessSessions } from '../db';
import { loadSoleMembership } from '../lib/tenancy/soleMembership';
import {
  resolveSessionStore,
  sessionKeyFor,
} from '../lib/tenancy/harnessSessionsRedis';
import {
  type BackfillMarkerStore,
  type HarnessSessionRecord,
  type ServerSessionStore,
  validateSessionRecord,
} from '../lib/sessions/sessionStore';
import type { Db } from '../db';
import type { SoleMembership } from '../lib/tenancy/soleMembership';

export type SessionsBackfillCounts = {
  dryRun: boolean;
  rows: number;
  /** Rows that would be (or were) migrated. In dry-run this is the planned count. */
  stored: number;
  /** Rows skipped because the per-{tenant,user} marker already exists (idempotent re-run). */
  markerSkipped: number;
  /** Rows skipped because the user has no sole tenant membership. */
  skippedNoTenant: number;
  /** Rows skipped because the legacy blob fails store validation (kept for re-run). */
  skippedInvalid: number;
};

export type SessionsBackfillDeps = {
  db: Db;
  loadMembership: {
    loadSoleMembership: (userId: string) => Promise<SoleMembership>;
  };
  store: ServerSessionStore & BackfillMarkerStore;
  dryRun?: boolean;
};

/**
 * Core, dependency-injected backfill. Tests call this directly with the shared
 * tenancy PGlite engine + an injected `MemorySessionStore` (no real Redis/Postgres
 * construction here — the DI gate is satisfied at every call site).
 */
export async function runSessionsBackfill(
  deps: SessionsBackfillDeps,
): Promise<SessionsBackfillCounts> {
  const dryRun = deps.dryRun ?? false;
  const rows = await deps.db
    .select({
      userId: harnessSessions.userId,
      snapshotId: harnessSessions.snapshotId,
      messages: harnessSessions.messages,
    })
    .from(harnessSessions);

  const counts: SessionsBackfillCounts = {
    dryRun,
    rows: 0,
    stored: 0,
    markerSkipped: 0,
    skippedNoTenant: 0,
    skippedInvalid: 0,
  };

  const now = Date.now();
  for (const row of rows) {
    counts.rows += 1;

    const membership = await deps.loadMembership.loadSoleMembership(row.userId);
    if (!membership.ok) {
      counts.skippedNoTenant += 1;
      console.warn(
        `[backfill-sessions] skipping userId=${row.userId}: no sole tenant membership (${membership.reason})`,
      );
      continue;
    }

    const scope = { tenantId: membership.tenantId, userId: row.userId };
    if (await deps.store.hasBackfillMarker(scope)) {
      counts.markerSkipped += 1;
      continue;
    }

    const record: HarnessSessionRecord = {
      id: crypto.randomUUID(),
      userId: row.userId,
      tenantId: membership.tenantId,
      createdAt: now,
      updatedAt: 0,
      messages: Array.isArray(row.messages)
        ? (row.messages as HarnessSessionRecord['messages'])
        : [],
      meta: { legacySnapshotId: row.snapshotId },
    };

    const validated = validateSessionRecord(record);
    if (!validated.ok) {
      counts.skippedInvalid += 1;
      console.warn(
        `[backfill-sessions] skipping userId=${row.userId}: legacy row fails store validation (${validated.error})`,
      );
      continue;
    }

    if (!dryRun) {
      const key = sessionKeyFor(scope.tenantId, scope.userId, validated.value.id);
      await deps.store.put(key, validated.value);
      await deps.store.setBackfillMarker(scope);
    }
    counts.stored += 1;
  }

  return counts;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  if (!process.env.DATABASE_URL?.trim()) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  if (!process.env.REDIS_URL?.trim()) {
    console.error('REDIS_URL is required (single RESP redis:// or rediss:// wire URL)');
    process.exit(1);
  }

  // Register the real session-store factory at the composition root (no in-body
  // construction), then resolve the store through the seam.
  createProdServices();
  const storeRes = await resolveSessionStore();
  if (!storeRes.ok) {
    console.error(`session store unavailable: ${storeRes.error}`);
    process.exit(1);
  }
  const store = storeRes.value as ServerSessionStore & BackfillMarkerStore;

  const conn = createScriptConnection();
  try {
    const counts = await runSessionsBackfill({
      db: conn.db,
      loadMembership: {
        loadSoleMembership: (userId) => loadSoleMembership(userId, { db: conn.db }),
      },
      store,
      dryRun,
    });
    // Single JSON line of counts — never REDIS_URL / credentials.
    console.log(JSON.stringify(counts));
  } finally {
    await conn.close();
  }
}

// Only run the CLI when executed directly (tsx scripts/backfill-sessions.ts), so
// importing `runSessionsBackfill` under vitest does not side-effect a backfill.
const isMain =
  typeof process.argv[1] === 'string' &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : 'backfill failed');
    process.exit(1);
  });
}
