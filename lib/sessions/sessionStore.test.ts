import { describe, expect, it } from 'vitest';
import {
  type HarnessSessionRecord,
  RESERVED_META_KEYS,
  isRedisSafeOpaqueId,
  validateMeta,
  validateSessionRecord,
  validateSessionRecordKey,
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

  it('enforces the Redis-safe opaque charset on id/tenant/user (adv. L2 glob bleed)', () => {
    const globs = ['*', '?', '[', ']', 'a:b', 'a*b', 'a?b', 'a/b', 'a b', 'a.b'];
    for (const bad of globs) {
      expect(validateSessionRecord(makeRecord({ id: bad })).ok).toBe(false);
      expect(validateSessionRecord(makeRecord({ tenantId: bad })).ok).toBe(false);
      expect(validateSessionRecord(makeRecord({ userId: bad })).ok).toBe(false);
    }
    // allowed charset still passes
    for (const ok of ['sess_abc-1', 'user-1', 'tenant_1', 'UUID0123456789abcdEF', 'a']) {
      expect(validateSessionRecord(makeRecord({ id: ok })).ok).toBe(true);
      expect(validateSessionRecord(makeRecord({ tenantId: ok })).ok).toBe(true);
      expect(validateSessionRecord(makeRecord({ userId: ok })).ok).toBe(true);
    }
    expect(isRedisSafeOpaqueId('*')).toBe(false);
    expect(isRedisSafeOpaqueId('a:b')).toBe(false);
    expect(isRedisSafeOpaqueId('sess_abc-1')).toBe(true);
  });

  it('rejects keys/scopes with non-safe ids (would break the KEYS list prefix)', () => {
    expect(validateSessionRecordKey({ tenantId: 't', userId: 'u', sessionId: '*' }).ok).toBe(false);
    expect(validateSessionRecordKey({ tenantId: 't', userId: '*', sessionId: 's' }).ok).toBe(false);
    expect(validateSessionRecordKey({ tenantId: '*', userId: 'u', sessionId: 's' }).ok).toBe(false);
    expect(validateSessionRecordKey({ tenantId: 't', userId: 'u', sessionId: 's' }).ok).toBe(true);
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
    expect(RESERVED_META_KEYS).toEqual([
      'activeSandboxId',
      'logicalCwd',
      'legacySnapshotId',
      'title',
    ]);
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
  const key = { tenantId: 'tenant-1', userId: 'user-1', sessionId: 's1' };

  it('round-trips get/put/list/remove', async () => {
    const s = new MemorySessionStore();
    await expect(s.get(key)).resolves.toBeNull();
    await s.put(key, makeRecord({ id: 's1' }));
    expect((await s.get(key))?.id).toBe('s1');
    expect((await s.list({ tenantId: 'tenant-1', userId: 'user-1' })).map((r) => r.id)).toEqual(['s1']);
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

  it('upsert preserves STORED createdAt even when the caller supplies a different one (adv. L1/L6 non-vacuous)', async () => {
    const s = new MemorySessionStore();
    await s.put(key, makeRecord({ id: 's1', createdAt: 1000, updatedAt: 0 }));
    // Caller wrongfully bumps createdAt; the store must keep the original.
    await s.put(key, makeRecord({ id: 's1', createdAt: 9999, updatedAt: 2000 }));
    const r = await s.get(key);
    expect(r?.createdAt).toBe(1000);
    expect(r?.updatedAt).toBe(2000);
  });

  it('rejects a key/record identity mismatch (confused-deputy guard, adv. L2)', async () => {
    const s = new MemorySessionStore();
    const mismatch = { ...key, userId: 'attacker' };
    await expect(
      s.put(mismatch, makeRecord({ id: 's1', tenantId: 'tenant-1', userId: 'u1' })),
    ).rejects.toThrow(/must match the session key/);
    await expect(
      s.put(key, makeRecord({ id: 'other-session' })),
    ).rejects.toThrow(/must match the session key/);
    await expect(
      s.put(key, makeRecord({ id: 's1', tenantId: 'other-tenant' })),
    ).rejects.toThrow(/must match the session key/);
  });

  it('rejects unsafe ids at the store boundary (get/put/list/remove)', async () => {
    const s = new MemorySessionStore();
    const badKey = { tenantId: 't1', userId: '*', sessionId: 's1' };
    await expect(s.get(badKey)).rejects.toThrow(/Invalid session key/);
    await expect(s.put(badKey, makeRecord({ id: 's1' }))).rejects.toThrow(/Invalid session key/);
    await expect(s.remove(badKey)).rejects.toThrow(/Invalid session key/);
    await expect(s.list({ tenantId: 't1', userId: '*' })).rejects.toThrow(/Invalid session list scope/);
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
  it('reads REDIS_URL (RESP wire format) as the store URL; opts.url overrides', () => {
    const prev = { ...process.env };
    try {
      delete process.env.REDIS_URL;
      process.env.REDIS_URL = 'redis://default:secret@dragons.example:6379';
      const store = new RedisSessionStore({ client: fakeClient().client });
      expect(store.url()).toBe('redis://default:secret@dragons.example:6379');

      // Explicit `url` option overrides the env var. Named-credential / TLS variants parse too.
      delete process.env.REDIS_URL;
      const overridden = new RedisSessionStore({
        client: fakeClient().client,
        url: 'rediss://default:pw@host:6380',
      });
      expect(overridden.url()).toBe('rediss://default:pw@host:6380');
    } finally {
      process.env = prev;
    }
  });

  it('throws when no client and no REDIS_URL are available', () => {
    const prev = { ...process.env };
    try {
      delete process.env.REDIS_URL;
      expect(() => new RedisSessionStore()).toThrow(/REDIS_URL/);
    } finally {
      process.env = prev;
    }
  });

  it('issues harness:session:{tenant}:{user}:{id} keys, lists per-user prefix, applies TTL ex', async () => {
    const { client, calls } = fakeClient();
    const key = { tenantId: 'tenant-1', userId: 'user-1', sessionId: 'id' };

    const noTtl = new RedisSessionStore({ client, ttlMs: 0 });
    await noTtl.put(key, makeRecord({ id: 'id' }));
    expect(calls.at(-1)?.key).toBe('harness:session:tenant-1:user-1:id');
    expect(calls.at(-1)?.opts).toBeUndefined(); // no `ex` when TTL 0

    expect((await noTtl.get(key))?.id).toBe('id');
    expect((await noTtl.list({ tenantId: 'tenant-1', userId: 'user-1' })).map((r) => r.id)).toEqual(['id']);
    await expect(noTtl.remove(key)).resolves.toBe(true);
    await expect(noTtl.get(key)).resolves.toBeNull();

    const withTtl = new RedisSessionStore({ client, ttlMs: 1500 });
    await withTtl.put(key, makeRecord({ id: 'id' }));
    expect(calls.at(-1)?.opts).toEqual({ ex: 2 }); // ceil(1500/1000)
  });

  it('enforces LWW on put via the injected client', async () => {
    const { client } = fakeClient();
    const store = new RedisSessionStore({ client });
    const key = { tenantId: 'tenant-1', userId: 'user-1', sessionId: 'id' };
    await store.put(key, makeRecord({ id: 'id', updatedAt: 5000 }));
    const rr = await store.put(key, makeRecord({ id: 'id', updatedAt: 4000 }));
    expect(rr.status).toBe('conflict');
    if (rr.status === 'conflict') expect(rr.server.updatedAt).toBe(5000);
  });

  it('rejects an invalid record at the store boundary', async () => {
    const { client } = fakeClient();
    const store = new RedisSessionStore({ client });
    const key = { tenantId: 'tenant-1', userId: 'user-1', sessionId: 'id' };
    await expect(
      store.put(key, { ...makeRecord(), meta: { unknownMeta: 1 } as HarnessSessionRecord['meta'] }),
    ).rejects.toThrow(/not a reserved key/);
  });

  it('upsert preserves STORED createdAt (caller-bumped createdAt is overwritten back)', async () => {
    const { client } = fakeClient();
    const store = new RedisSessionStore({ client });
    const key = { tenantId: 'tenant-1', userId: 'user-1', sessionId: 'id' };
    await store.put(key, makeRecord({ id: 'id', createdAt: 1000, updatedAt: 0 }));
    await store.put(key, makeRecord({ id: 'id', createdAt: 9999, updatedAt: 2000 }));
    expect((await store.get(key))?.createdAt).toBe(1000);
    expect((await store.get(key))?.updatedAt).toBe(2000);
  });

  it('rejects a key/record identity mismatch and unsafe ids at the Redis boundary', async () => {
    const { client } = fakeClient();
    const store = new RedisSessionStore({ client });
    const key = { tenantId: 'tenant-1', userId: 'user-1', sessionId: 'id' };
    await expect(
      store.put({ ...key, userId: 'attacker' }, makeRecord({ id: 'id', userId: 'u' })),
    ).rejects.toThrow(/must match the session key/);
    await expect(
      store.put(
        { tenantId: 'tenant-1', userId: 'user-1', sessionId: '*' },
        makeRecord({ id: 'ok', tenantId: 'tenant-1', userId: 'user-1' }),
      ),
    ).rejects.toThrow(/Invalid session key/);
    await expect(store.get({ tenantId: 'tenant-1', userId: 'user-1', sessionId: '*' })).rejects.toThrow(/Invalid session key/);
    await expect(store.list({ tenantId: 'tenant-1', userId: '*' })).rejects.toThrow(/Invalid session list scope/);
  });

  it('drops schema-valid but identity-mismatched blobs on read (read-path re-bind, adv. re-run Minor L2)', async () => {
    const map = new Map<string, unknown>();
    const { client } = fakeClient(map);
    const store = new RedisSessionStore({ client });
    const key = { tenantId: 'tenant-1', userId: 'user-1', sessionId: 'id' };

    // A schema-valid blob whose OWN identity does NOT match the key it lives under
    // (e.g. hand-edited Redis / bad migration): schema passes, bind fails → null.
    map.set('harness:session:tenant-1:user-1:id', {
      id: 'id',
      tenantId: 'tenant-1',
      userId: 'other-user', // identity mismatch
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      meta: {},
    });
    await expect(store.get(key)).resolves.toBeNull();
    expect(await store.list({ tenantId: 'tenant-1', userId: 'user-1' })).toEqual([]);

    // Same for tenant off-by-one and session-id mismatch.
    map.clear();
    map.set('harness:session:tenant-1:user-1:id', makeRecord({ id: 'id', tenantId: 'tenant-9', updatedAt: 1 }));
    await expect(store.get(key)).resolves.toBeNull();
    map.set('harness:session:tenant-1:user-1:id', makeRecord({ id: 'different', updatedAt: 1 }));
    await expect(store.get(key)).resolves.toBeNull();
  });

  it('memory double mirrors the read-path identity re-bind (fail closed)', async () => {
    const s = new MemorySessionStore();
    const key = { tenantId: 'tenant-1', userId: 'user-1', sessionId: 'id' };
    await s.put(key, makeRecord({ id: 'id' }));
    // A valid record under its own key still round-trips.
    expect((await s.get(key))?.id).toBe('id');
    // Corrupt the double's map directly so it no longer matches its key → get fails closed.
    (s as unknown as { store: Map<string, unknown> }).store.set(
      'harness:session:tenant-1:user-1:other',
      makeRecord({ id: 'other', tenantId: 'tenant-1', userId: 'user-1', updatedAt: 1 }),
    );
    expect((await s.get({ tenantId: 'tenant-1', userId: 'user-1', sessionId: 'other' }))?.id).toBe('other');
    // A record bound to a DIFFERENT sessionId than its key is dropped from list/get.
    (s as unknown as { store: Map<string, unknown> }).store.set(
      'harness:session:tenant-1:user-1:stray',
      makeRecord({ id: 'not_the_key', updatedAt: 1 }),
    );
    expect(
      (await s.list({ tenantId: 'tenant-1', userId: 'user-1' })).map((r) => r.id),
    ).toEqual(['id', 'other']);
    await expect(
      s.get({ tenantId: 'tenant-1', userId: 'user-1', sessionId: 'stray' }),
    ).resolves.toBeNull();
  });

  it('trust-but-verifies reads from Redis: corrupt blobs yield null / are skipped (adv. minor L1)', async () => {
    const map = new Map<string, unknown>();
    const { client } = fakeClient(map);
    const store = new RedisSessionStore({ client });
    const key = { tenantId: 'tenant-1', userId: 'user-1', sessionId: 'id' };

    // Hand-edited / corrupt value (unknown meta key) under a well-formed key.
    map.set('harness:session:tenant-1:user-1:id', {
      id: 'id',
      userId: 'user-1',
      tenantId: 'tenant-1',
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      meta: { smuggled: 1 },
    });
    await expect(store.get(key)).resolves.toBeNull();

    // A valid sibling plus a corrupt one: list skips the corrupt blob.
    await store.put(key, makeRecord({ id: 'id', updatedAt: 5 }));
    await store.put(
      { tenantId: 'tenant-1', userId: 'user-1', sessionId: 'other' },
      makeRecord({ id: 'other', updatedAt: 5 }),
    );
    map.set('harness:session:tenant-1:user-1:corrupt', { meta: { smuggled: 1 } });
    const ids = (await store.list({ tenantId: 'tenant-1', userId: 'user-1' })).map((r) => r.id).sort();
    expect(ids).toEqual(['id', 'other']);
  });
});
