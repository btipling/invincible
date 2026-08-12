import { createTenancyTestDb } from './test/pglite';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../db/schema';
import {
  HARNESS_SESSION_MAX_MSG_BYTES,
  deleteHarnessSession,
  getHarnessSession,
  putHarnessSession,
  validateSessionSnapshot,
} from './harnessSessions';

describe('harnessSessions', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let userId: string;
  let otherUserId: string;

  beforeAll(async () => {

    ({ client, db } = await createTenancyTestDb());
  });


  beforeEach(async () => {
    await db.delete(schema.harnessSessions);
    await db.delete(schema.users);

    const [user] = await db
      .insert(schema.users)
      .values({ email: 'owner@example.com', status: 'active' })
      .returning({ id: schema.users.id });
    userId = user.id;

    const [other] = await db
      .insert(schema.users)
      .values({ email: 'other@example.com', status: 'active' })
      .returning({ id: schema.users.id });
    otherUserId = other.id;
  });

  const deps = () => ({ db: db as never });

  it('accepts opaque sess_… snapshot id (not uuid)', () => {
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

  it('rejects oversize message UTF-8 bytes', () => {
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

  it('PUT happy path + GET round-trip', async () => {
    const snap = {
      id: 'sess_m1abc_xyz12',
      updatedAt: 1_700_000_000_100,
      messages: [
        { id: 'm_a', role: 'user' as const, text: 'hello', at: 1_700_000_000_000 },
        { id: 'm_b', role: 'assistant' as const, text: 'hi', at: 1_700_000_000_050 },
      ],
    };
    const put = await putHarnessSession(userId, snap, deps());
    expect(put.ok).toBe(true);
    if (!put.ok) throw new Error(put.error);

    const got = await getHarnessSession(userId, deps());
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error(got.error);
    expect(got.value).toEqual(snap);
  });

  it('LWW: older updatedAt → conflict; equal accepted', async () => {
    const t0 = 1_700_000_000_000;
    const first = await putHarnessSession(
      userId,
      {
        id: 'sess_a',
        updatedAt: t0 + 100,
        messages: [{ id: 'm_1', role: 'user', text: 'a', at: t0 }],
      },
      deps(),
    );
    expect(first.ok).toBe(true);

    const stale = await putHarnessSession(
      userId,
      {
        id: 'sess_stale',
        updatedAt: t0 + 50,
        messages: [{ id: 'm_2', role: 'user', text: 'stale', at: t0 }],
      },
      deps(),
    );
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error('expected conflict');
    expect(stale.code).toBe('conflict');
    expect(stale.value?.id).toBe('sess_a');
    expect(stale.value?.messages[0]?.text).toBe('a');

    const equal = await putHarnessSession(
      userId,
      {
        id: 'sess_equal',
        updatedAt: t0 + 100,
        messages: [{ id: 'm_3', role: 'user', text: 'equal-overwrite', at: t0 }],
      },
      deps(),
    );
    expect(equal.ok).toBe(true);
    if (!equal.ok) throw new Error(equal.error);
    expect(equal.value.id).toBe('sess_equal');
    expect(equal.value.messages[0]?.text).toBe('equal-overwrite');
  });

  it('cross-user isolation', async () => {
    await putHarnessSession(
      userId,
      {
        id: 'sess_owner',
        updatedAt: 100,
        messages: [{ id: 'm_1', role: 'user', text: 'private', at: 1 }],
      },
      deps(),
    );

    const otherGet = await getHarnessSession(otherUserId, deps());
    expect(otherGet.ok).toBe(false);
    if (otherGet.ok) throw new Error('leak');
    expect(otherGet.code).toBe('not_found');

    await putHarnessSession(
      otherUserId,
      {
        id: 'sess_other',
        updatedAt: 200,
        messages: [{ id: 'm_2', role: 'user', text: 'other', at: 2 }],
      },
      deps(),
    );

    const owner = await getHarnessSession(userId, deps());
    expect(owner.ok).toBe(true);
    if (!owner.ok) throw new Error(owner.error);
    expect(owner.value.messages[0]?.text).toBe('private');

    const rows = await db.select().from(schema.harnessSessions);
    expect(rows).toHaveLength(2);
  });

  it('LWW concurrent: older writer cannot clobber newer after race window', async () => {
    const t0 = 1_700_000_000_000;
    const newer = await putHarnessSession(
      userId,
      {
        id: 'sess_new',
        updatedAt: t0 + 200,
        messages: [{ id: 'm_n', role: 'user', text: 'newer', at: t0 }],
      },
      deps(),
    );
    expect(newer.ok).toBe(true);

    // Simulate a stale concurrent writer that already passed a soft pre-check at t0+100
    // against a previous server value — atomic setWhere must still reject.
    const stale = await putHarnessSession(
      userId,
      {
        id: 'sess_stale_race',
        updatedAt: t0 + 100,
        messages: [{ id: 'm_s', role: 'user', text: 'stale-race', at: t0 }],
      },
      deps(),
    );
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error('expected conflict');
    expect(stale.code).toBe('conflict');
    expect(stale.value?.id).toBe('sess_new');
    expect(stale.value?.messages[0]?.text).toBe('newer');

    const got = await getHarnessSession(userId, deps());
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error(got.error);
    expect(got.value.id).toBe('sess_new');
    expect(got.value.messages[0]?.text).toBe('newer');
  });

  it('rejects non-integer / negative updatedAt', () => {
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

  it('DELETE is idempotent', async () => {
    await putHarnessSession(
      userId,
      {
        id: 'sess_del',
        updatedAt: 10,
        messages: [],
      },
      deps(),
    );
    const d1 = await deleteHarnessSession(userId, deps());
    expect(d1.ok).toBe(true);
    if (!d1.ok) throw new Error(d1.error);
    expect(d1.value.deleted).toBe(true);

    const d2 = await deleteHarnessSession(userId, deps());
    expect(d2.ok).toBe(true);
    if (!d2.ok) throw new Error(d2.error);
    expect(d2.value.deleted).toBe(false);

    const remaining = await db
      .select()
      .from(schema.harnessSessions)
      .where(eq(schema.harnessSessions.userId, userId));
    expect(remaining).toHaveLength(0);
  });
});
