import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getSharedDb, resetTenantTables } from '../lib/tenancy/test/shared';
import { MemorySessionStore } from '../lib/sessions/memorySessionStore';
import {
  backfillMarkerKey,
  parseSessionKeyString,
  type SessionListScope,
} from '../lib/sessions/sessionStore';
import { loadSoleMembership } from '../lib/tenancy/soleMembership';
import { runSessionsBackfill, type SessionsBackfillCounts } from './backfill-sessions';
import * as schema from '../db/schema';
import type { Db } from '../db';

let db!: Db;

describe('backfill-sessions (shared tenancy PGlite)', () => {
  beforeAll(async () => {
    db = (await getSharedDb()) as unknown as Db;
  });

  beforeEach(async () => {
    await resetTenantTables();
  });

  async function seedMembership(email: string) {
    const [tenant] = await db
      .insert(schema.tenants)
      .values({ slug: `t-${email}`, name: email })
      .returning({ id: schema.tenants.id });
    const [user] = await db
      .insert(schema.users)
      .values({ email, status: 'active' })
      .returning({ id: schema.users.id });
    await db
      .insert(schema.tenantMembers)
      .values({ tenantId: tenant!.id, userId: user!.id, role: 'owner' });
    return { tenantId: tenant!.id, userId: user!.id };
  }

  async function seedLegacyRow(userId: string, snapshotId = 'sess_legacy') {
    await db.insert(schema.harnessSessions).values({
      userId,
      snapshotId,
      updatedAt: new Date(1_700_000_000_000),
      messages: [{ id: 'm_1', role: 'user', text: 'hi', at: 1_700_000_000_000 }],
    });
  }

  function deps(store: MemorySessionStore, dryRun = false) {
    return {
      db,
      loadMembership: {
        loadSoleMembership: (userId: string) => loadSoleMembership(userId, { db }),
      },
      store,
      dryRun,
    };
  }

  const scopeOf = (tenantId: string, userId: string): SessionListScope => ({
    tenantId,
    userId,
  });

  it('mints a new UUID id, seeds updatedAt:0 + createdAt, and stores meta.legacySnapshotId', async () => {
    const { tenantId, userId } = await seedMembership('a@t.com');
    await seedLegacyRow(userId, 'sess_legacy_abc');

    const store = new MemorySessionStore();
    const counts = await runSessionsBackfill(deps(store));

    expect(counts.rows).toBe(1);
    expect(counts.stored).toBe(1);
    expect(counts.markerSkipped).toBe(0);
    expect(counts.skippedNoTenant).toBe(0);
    expect(counts.skippedInvalid).toBe(0);
    expect(counts.dryRun).toBe(false);

    const list = await store.list(scopeOf(tenantId, userId));
    expect(list).toHaveLength(1);
    expect(list[0].id).toBeTypeOf('string');
    expect(list[0].id).not.toBe('sess_legacy_abc');
    expect(list[0].tenantId).toBe(tenantId);
    expect(list[0].userId).toBe(userId);
    expect(list[0].updatedAt).toBe(0);
    expect(list[0].createdAt).toBeGreaterThan(0);
    expect(list[0].meta.legacySnapshotId).toBe('sess_legacy_abc');
    expect(list[0].messages).toHaveLength(1);
    expect(await store.hasBackfillMarker(scopeOf(tenantId, userId))).toBe(true);
  });

  it('is idempotent: a second run reads the marker and stores nothing (re-run adds nothing)', async () => {
    const { tenantId, userId } = await seedMembership('b@t.com');
    await seedLegacyRow(userId);

    const store = new MemorySessionStore();
    const first = await runSessionsBackfill(deps(store));
    expect(first.stored).toBe(1);

    const second = await runSessionsBackfill(deps(store));
    expect(second.stored).toBe(0);
    expect(second.markerSkipped).toBe(1);
    expect(second.rows).toBe(1);

    const list = await store.list(scopeOf(tenantId, userId));
    expect(list).toHaveLength(1);
  });

  it('dry-run mutates nothing: counts planned rows but writes no record and no marker', async () => {
    const { tenantId, userId } = await seedMembership('c@t.com');
    await seedLegacyRow(userId);

    const store = new MemorySessionStore();
    const counts = await runSessionsBackfill(deps(store, true));

    expect(counts.dryRun).toBe(true);
    expect(counts.stored).toBe(1);
    expect(await store.list(scopeOf(tenantId, userId))).toHaveLength(0);
    expect(await store.hasBackfillMarker(scopeOf(tenantId, userId))).toBe(false);
    // No credential material is ever serialized (dry-run or not).
    expect(JSON.stringify(counts)).not.toMatch(/redis|:\/\//);
  });

  it('skips + warns a row whose user has no sole tenant membership', async () => {
    const [user] = await db
      .insert(schema.users)
      .values({ email: 'nobody@t.com', status: 'active' })
      .returning({ id: schema.users.id });
    await seedLegacyRow(user!.id, 'sess_orphan');

    const store = new MemorySessionStore();
    const counts = await runSessionsBackfill(deps(store));

    expect(counts.rows).toBe(1);
    expect(counts.skippedNoTenant).toBe(1);
    expect(counts.stored).toBe(0);
    expect(counts.markerSkipped).toBe(0);
    expect(await store.hasBackfillMarker(scopeOf('ignored-tenant', user!.id))).toBe(false);
  });

  it('skips an oversized/invalid legacy message (kept for re-run), leaving the marker unset', async () => {
    const { tenantId, userId } = await seedMembership('d@t.com');
    const { HARNESS_SESSION_MAX_MSG_BYTES } = await import('../lib/sessionCloudCaps');
    await db.insert(schema.harnessSessions).values({
      userId,
      snapshotId: 'sess_oversize',
      updatedAt: new Date(1),
      messages: [
        { id: 'm_1', role: 'user', text: 'x'.repeat(HARNESS_SESSION_MAX_MSG_BYTES + 1), at: 1 },
      ],
    });

    const store = new MemorySessionStore();
    const counts = await runSessionsBackfill(deps(store));

    expect(counts.skippedInvalid).toBe(1);
    expect(counts.stored).toBe(0);
    expect(await store.list(scopeOf(tenantId, userId))).toHaveLength(0);
    expect(await store.hasBackfillMarker(scopeOf(tenantId, userId))).toBe(false);
  });

  it('backfill marker keys live outside the harness:session:* glob', () => {
    const scope: SessionListScope = { tenantId: 't', userId: 'u' };
    expect(backfillMarkerKey(scope)).toBe('harness:sessions-backfill:t:u:v1');
    expect(backfillMarkerKey(scope)).not.toMatch(/^harness:session:/);
    // A marker key must never parse into a session record key (separate namespace).
    expect(parseSessionKeyString(backfillMarkerKey(scope))).toBeNull();
  });
});
