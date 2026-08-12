import { describe, expect, it } from 'vitest';
import {
  type HarnessSessionRecord,
  RESERVED_META_KEYS,
  validateMeta,
  validateSessionRecord,
  sessionKeyString,
  sessionPrefix,
} from './sessionStore';
import { MemorySessionStore } from './memorySessionStore';
import { RedisSessionStore, type RedisClientLike } from './redisSessionStore';

function makeRecord(overrides: Partial<HarnessSessionRecord> = {}): HarnessSessionRecord {
  return {
    id: 'sess_abc',
    userId: 'user-1',
    tenantId: 'tenant-1',
    createdAt: 1000,
    updatedAt: 0,
    messages: [],
    meta: {},
    ...overrides,
  };
}

/** Fake Redis client backed by a Map; records the last set key/opts for assertions. */
function fakeClient(map: Map<string, unknown> = new Map()) {
  const calls: { key: string; opts?: { ex?: number } }[] = [];
  const client: RedisClientLike = {
    async get(key) {
      return map.has(key) ? structuredClone(map.get(key)) : null;
    },
    async set(key, value, opts) {
      map.set(key, structuredClone(value));
      calls.push({ key, opts });
      return 'OK';
    },
    async del(...keys) {
      for (const k of keys) map.delete(k);
      return keys.length;
    },
    async keys(pattern) {
      const base = pattern.slice(0, -1);
      return [...map.keys()].filter((k) => k.startsWith(base));
    },
  };
  return { client, calls, map };
}

describe('sessionStore — key helpers', () => {
  it('builds single-record keys and per-user list prefixes with tenant:user scoping', () => {
    const key = { tenantId: 't1', userId: 'u1', sessionId: 's1' };
    expect(sessionKeyString(key)).toBe('harness:session:t1:u1:s1');
    expect(sessionPrefix({ tenantId: 't1', userId: 'u1' })).toBe('harness:session:t1:u1:*');
  });
});

describe('validateSessionRecord', () => {
  it('accepts a valid record (reuses caps + meta)', () => {
    const res = validateSessionRecord(makeRecord());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.id).toBe('sess_abc');
      expect(res.value.messages).toEqual([]);
      expect(res.value.meta).toEqual({});
    }
  });

  it('reuses message / id / updatedAt caps (max msg bytes, role, id)', () => {
    // message text over cap
    expect(
      validateSessionRecord(makeRecord({ messages: [{ id: 'm1', role: 'user', text: 'x'.repeat(262_144 + 1), at: 1 }] })).ok,
    ).toBe(false);
    // invalid role
    expect(
      validateSessionRecord(
        makeRecord({ messages: [{ id: 'm1', role: 'troll' as never, text: 'hi', at: 1 }] }),
      ).ok,
    ).toBe(false);
    // valid message
    expect(
      validateSessionRecord(
        makeRecord({ messages: [{ id: 'm1', role: 'user', text: 'hi', at: 1 }] }),
      ).ok,
    ).toBe(true);
    // negative updatedAt
    expect(validateSessionRecord(makeRecord({ updatedAt: -1 })).ok).toBe(false);
    // empty id
    expect(validateSessionRecord(makeRecord({ id: '' })).ok).toBe(false);
  });

  it('rejects missing/invalid tenant/user/createdAt', () => {
    expect(validateSessionRecord(makeRecord({ tenantId: '' })).ok).toBe(false);
    expect(validateSessionRecord(makeRecord({ userId: 7 as never })).ok).toBe(false);
    expect(validateSessionRecord(makeRecord({ createdAt: -5 })).ok).toBe(false);
  });
});

describe('meta — schema-typed reserved (parent #411 lock)', () => {
  it('allows absent / null / empty meta as {}', () => {
    expect(validateMeta(undefined).ok).toBe(true);
    expect(validateMeta(null).ok).toBe(true);
    expect(validateSessionRecord(makeRecord({ meta: undefined })).ok).toBe(true);
  });

  it('rejects non-object meta', () => {
    expect(validateMeta('nope').ok).toBe(false);
    expect(validateMeta([]).ok).toBe(false);
    expect(
      validateSessionRecord(
        makeRecord({ meta: ('secret? no' as unknown) as HarnessSessionRecord['meta'] }),
      ).ok,
    ).toBe(false);
  });

  it('accepts only reserved keys; rejects unknown keys', () => {
    expect(RESERVED_META_KEYS).toEqual(['activeSandboxId', 'logicalCwd', 'legacySnapshotId']);
    for (const k of RESERVED_META_KEYS) {
      const rawMeta: unknown = { [k]: 'x' };
      const res = validateSessionRecord(
        makeRecord({ meta: rawMeta as HarnessSessionRecord['meta'] }),
      );
      expect(res.ok).toBe(true);
    }
    const badMeta: unknown = { arbitrary: 'x' };
    expect(validateSessionRecord(makeRecord({ meta: badMeta as HarnessSessionRecord['meta'] })).ok).toBe(false);
  });

  it('rejects oversized meta (size cap), accepts opaque scalar values without sniffing', () => {
    expect(validateSessionRecord(makeRecord({ meta: { logicalCwd: 'x'.repeat(4096) } })).ok).toBe(false);
    // Opaque passthrough: a secret-looking value inside a reserved key is allowed — the
    // reserved key set + cap is the contract, not free-form "secret-looking" sniffing.
    expect(
      validateSessionRecord(makeRecord({ meta: { legacySnapshotId: 'sess_tok_0123456789abcdef', activeSandboxId: 'sbx-1' } })).ok,
    ).toBe(true);
  });
});

describe('MemorySessionStore', () => {
  const key = { tenantId: 't1', userId: 'u1', sessionId: 's1' };

  it('round-trips get/put/list/remove', async () => {
    const s = new MemorySessionStore();
    await expect(s.get(key)).resolves.toBeNull();
    await s.put(key, makeRecord({ id: 's1' }));
    expect((await s.get(key))?.id).toBe('s1');
    expect((await s.list({ tenantId: 't1', userId: 'u1' })).map((r) => r.id)).toEqual(['s1']);
    await expect(s.remove(key)).resolves.toBe(true);
    await expect(s.remove(key)).resolves.toBe(false);
    await expect(s.get(key)).resolves.toBeNull();
  });

  it('create preserves supplied id/createdAt/updatedAt (incl 0); upsert bumps updatedAt; stale -> conflict', async () => {
    const s = new MemorySessionStore();
    const created = makeRecord({ id: 's1', createdAt: 1000, updatedAt: 0 });
    const r = await s.put(key, created);
    expect(r.status).toBe('stored');
    const afterCreate = await s.get(key);
    // create does NOT auto-bump updatedAt (sealed 0 preserved) and keeps createdAt
    expect(afterCreate?.updatedAt).toBe(0);
    expect(afterCreate?.createdAt).toBe(1000);

    // upsert with a newer updatedAt keeps createdAt, advances updatedAt
    await s.put(key, makeRecord({ id: 's1', createdAt: 1000, updatedAt: 2000 }));
    const afterUpd = await s.get(key);
    expect(afterUpd?.updatedAt).toBe(2000);
    expect(afterUpd?.createdAt).toBe(1000);

    // a stale write is rejected with the server record
    const rr = await s.put(key, makeRecord({ id: 's1', createdAt: 1000, updatedAt: 1500 }));
    expect(rr.status).toBe('conflict');
    if (rr.status === 'conflict') expect(rr.server.updatedAt).toBe(2000);
  });

  it('list is scoped to the {tenant,user} prefix only', async () => {
    const s = new MemorySessionStore();
    const cases = [
      ['t1', 'u1', 'a'],
      ['t1', 'u1', 'b'],
      ['t1', 'u2', 'c'],
      ['t2', 'u1', 'd'],
      ['t1', 'u1x', 'e'], // longer user id must NOT match prefix u1:
    ] as const;
    for (const [tenantId, userId, id] of cases) {
      await s.put({ tenantId, userId, sessionId: id }, makeRecord({ id, tenantId, userId }));
    }
    const ids = (await s.list({ tenantId: 't1', userId: 'u1' })).map((r) => r.id).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('rejects an invalid record at the store boundary', async () => {
    const s = new MemorySessionStore();
    await expect(
      s.put(key, { ...makeRecord(), meta: { notReserved: 1 } as HarnessSessionRecord['meta'] }),
    ).rejects.toThrow(/not a reserved key/);
  });
});

describe('RedisSessionStore', () => {
  it('resolves SESSION_REDIS_* first, then UPSTASH_REDIS_* fallback', () => {
    const prev = { ...process.env };
    try {
      delete process.env.SESSION_REDIS_URL;
      delete process.env.SESSION_REDIS_TOKEN;
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;

      process.env.SESSION_REDIS_URL = 'https://session.example';
      process.env.SESSION_REDIS_TOKEN = 'a';
      let store = new RedisSessionStore({ client: fakeClient().client });
      expect(store.url()).toBe('https://session.example');
      expect(store.token()).toBe('a');

      delete process.env.SESSION_REDIS_URL;
      delete process.env.SESSION_REDIS_TOKEN;
      process.env.UPSTASH_REDIS_REST_URL = 'https://fallback.example';
      process.env.UPSTASH_REDIS_REST_TOKEN = 'b';
      store = new RedisSessionStore({ client: fakeClient().client });
      expect(store.url()).toBe('https://fallback.example');
      expect(store.token()).toBe('b');
    } finally {
      process.env = prev;
    }
  });

  it('throws when no client and no URL/token are available', () => {
    const prev = { ...process.env };
    try {
      delete process.env.SESSION_REDIS_URL;
      delete process.env.SESSION_REDIS_TOKEN;
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
      expect(() => new RedisSessionStore()).toThrow(/SESSION_REDIS_URL/);
    } finally {
      process.env = prev;
    }
  });

  it('issues harness:session:{tenant}:{user}:{id} keys, lists per-user prefix, applies TTL ex', async () => {
    const { client, calls } = fakeClient();
    const key = { tenantId: 't', userId: 'u', sessionId: 'id' };

    const noTtl = new RedisSessionStore({ client, ttlMs: 0 });
    await noTtl.put(key, makeRecord({ id: 'id' }));
    expect(calls.at(-1)?.key).toBe('harness:session:t:u:id');
    expect(calls.at(-1)?.opts).toBeUndefined(); // no `ex` when TTL 0

    expect((await noTtl.get(key))?.id).toBe('id');
    expect((await noTtl.list({ tenantId: 't', userId: 'u' })).map((r) => r.id)).toEqual(['id']);
    await expect(noTtl.remove(key)).resolves.toBe(true);
    await expect(noTtl.get(key)).resolves.toBeNull();

    const withTtl = new RedisSessionStore({ client, ttlMs: 1500 });
    await withTtl.put(key, makeRecord({ id: 'id' }));
    expect(calls.at(-1)?.opts).toEqual({ ex: 2 }); // ceil(1500/1000)
  });

  it('enforces LWW on put via the injected client', async () => {
    const { client } = fakeClient();
    const store = new RedisSessionStore({ client });
    const key = { tenantId: 't', userId: 'u', sessionId: 'id' };
    await store.put(key, makeRecord({ id: 'id', updatedAt: 5000 }));
    const rr = await store.put(key, makeRecord({ id: 'id', updatedAt: 4000 }));
    expect(rr.status).toBe('conflict');
    if (rr.status === 'conflict') expect(rr.server.updatedAt).toBe(5000);
  });

  it('rejects an invalid record at the store boundary', async () => {
    const { client } = fakeClient();
    const store = new RedisSessionStore({ client });
    const key = { tenantId: 't', userId: 'u', sessionId: 'id' };
    await expect(
      store.put(key, { ...makeRecord(), meta: { unknownMeta: 1 } as HarnessSessionRecord['meta'] }),
    ).rejects.toThrow(/not a reserved key/);
  });
});
