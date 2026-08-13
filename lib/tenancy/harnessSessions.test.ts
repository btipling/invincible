import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../db/schema';
import {
  HARNESS_SESSION_MAX_MSG_BYTES,
  getHarnessSession,
  validateSessionSnapshot,
} from './harnessSessions';
import { createHarnessSessions } from './harnessSessions';
import { getSharedDb, resetTenantTables } from './test/shared';

let db!: ReturnType<typeof drizzle<typeof schema>>;

describe('harnessSessions (Phase 4 — Postgres is a read-only archive after backfill)', () => {
  beforeAll(async () => {
    db = await getSharedDb();
  });

  beforeEach(async () => {
    await resetTenantTables();
  });

  /** The archive read is DI-wired with a fixed deps closure (same as the root). */
  const deps = () => ({ db: db as never });
  const archive = createHarnessSessions(deps());

  async function seedSession(userId: string, snapshotId: string) {
    await db.insert(schema.harnessSessions).values({
      userId,
      snapshotId,
      updatedAt: new Date(1_700_000_000_100),
      messages: [{ id: 'm_1', role: 'user', text: 'hi', at: 1_700_000_000_000 }],
    });
  }

  it('getHarnessSession reads the archived row (shared validator + caps retained)', async () => {
    const [user] = await db
      .insert(schema.users)
      .values({ email: 'owner@example.com', status: 'active' })
      .returning({ id: schema.users.id });
    await seedSession(user!.id, 'sess_m1abc_xyz12');

    const got = await getHarnessSession(user!.id, deps());
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error(got.error);
    expect(got.value).toEqual({
      id: 'sess_m1abc_xyz12',
      updatedAt: 1_700_000_000_100,
      messages: [{ id: 'm_1', role: 'user', text: 'hi', at: 1_700_000_000_000 }],
    });
  });

  it('getHarnessSession 404 when the user has no archived row', async () => {
    const [user] = await db
      .insert(schema.users)
      .values({ email: 'other@example.com', status: 'active' })
      .returning({ id: schema.users.id });

    const got = await getHarnessSession(user!.id, deps());
    expect(got.ok).toBe(false);
    if (got.ok) throw new Error('leak');
    expect(got.code).toBe('not_found');
  });

  it('cross-user isolation on the archive read', async () => {
    const [owner] = await db
      .insert(schema.users)
      .values({ email: 'owner2@example.com', status: 'active' })
      .returning({ id: schema.users.id });
    const [other] = await db
      .insert(schema.users)
      .values({ email: 'other2@example.com', status: 'active' })
      .returning({ id: schema.users.id });
    await seedSession(owner!.id, 'sess_owner');
    await seedSession(other!.id, 'sess_other');

    const ownerGot = await getHarnessSession(owner!.id, deps());
    expect(ownerGot.ok).toBe(true);
    if (!ownerGot.ok) throw new Error(ownerGot.error);
    expect(ownerGot.value.id).toBe('sess_owner');

    const otherGot = await getHarnessSession(other!.id, deps());
    expect(otherGot.ok).toBe(true);
    if (!otherGot.ok) throw new Error(otherGot.error);
    expect(otherGot.value.id).toBe('sess_other');

    const rows = await db.select().from(schema.harnessSessions);
    expect(rows).toHaveLength(2);
  });

  it('accepts opaque sess_… snapshot id (not uuid) in the shared validator', () => {
    const v = validateSessionSnapshot({
      id: 'sess_m1abc_xyz12',
      updatedAt: 1_700_000_000_000,
      messages: [
        { id: 'm_1', role: 'user', text: 'hi', at: 1_700_000_000_000 },
      ],
    });
    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error(v.error);
    expect(v.value.id).toBe('sess_m1abc_xyz12');
  });

  it('rejects oversize message UTF-8 bytes in the shared validator', () => {
    const text = 'é'.repeat(HARNESS_SESSION_MAX_MSG_BYTES); // 2 bytes each → over MAX_MSG_LEN
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(HARNESS_SESSION_MAX_MSG_BYTES);
    const v = validateSessionSnapshot({
      id: 'sess_x',
      updatedAt: 1,
      messages: [{ id: 'm_1', role: 'user', text, at: 1 }],
    });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('expected fail');
    expect(v.code).toBe('message_too_large');
  });

  it('rejects non-integer / negative updatedAt in the shared validator', () => {
    for (const updatedAt of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const v = validateSessionSnapshot({
        id: 'sess_x',
        updatedAt,
        messages: [],
      });
      expect(v.ok).toBe(false);
      if (v.ok) throw new Error('expected fail');
      expect(v.code).toBe('invalid_updated_at');
    }
  });

  it('createHarnessSessions exposes only the archive read (no legacy write path)', () => {
    expect(typeof archive.getHarnessSession).toBe('function');
    expect('putHarnessSession' in archive).toBe(false);
    expect('deleteHarnessSession' in archive).toBe(false);
  });
});
